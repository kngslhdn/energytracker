import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';

const SESSION_COOKIE = 'et_session';
const SESSION_HOURS = 12;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const passwordHash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const verifyPassword = (password: string, stored: string) => {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const getCookie = (req: Request, name: string) => {
  const item = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
};
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.APP_ENV === 'production', path: '/', maxAge: SESSION_HOURS * 60 * 60 * 1000 });

export function authRouter(pool: Pool) {
  const router = Router();
  router.post('/bootstrap', async (req, res) => {
    const expectedToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
    const { token, username, displayName, password } = req.body || {};
    if (!expectedToken || expectedToken.length < 24) return res.status(503).json({ error: 'Initial admin bootstrap is disabled. Configure a strong BOOTSTRAP_ADMIN_TOKEN temporarily.' });
    if (typeof token !== 'string' || token !== expectedToken) return res.status(403).json({ error: 'Invalid bootstrap token.' });
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,48}$/.test(username) || typeof displayName !== 'string' || displayName.trim().length < 2 || typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'Provide a valid username, display name, and password of at least 12 characters.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const count = await client.query('SELECT count(*)::int AS total FROM app_users');
      if (count.rows[0].total > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Bootstrap is closed because a user already exists.' }); }
      const created = await client.query('INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role', [username, displayName.trim(), passwordHash(password), 'admin']);
      await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,ip_address) VALUES($1,$2,$3,$4,$5)', [created.rows[0].id, 'bootstrap_admin_created', 'app_users', created.rows[0].id, req.ip || null]);
      await client.query('COMMIT');
      return res.status(201).json({ user: created.rows[0], message: 'Admin created. Remove BOOTSTRAP_ADMIN_TOKEN from the environment now.' });
    } catch (error) { await client.query('ROLLBACK'); if ((error as {code?:string}).code === '23505') return res.status(409).json({ error: 'Username already exists.' }); return res.status(500).json({ error: 'Unable to create initial admin.' }); }
    finally { client.release(); }
  });
  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 48 || password.length > 256) return res.status(400).json({ error: 'Username and password are required.' });
    try {
      const result = await pool.query('SELECT id,username,display_name,password_hash,role FROM app_users WHERE username=$1 AND is_active=true', [username]);
      const user = result.rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password.' });
      const token = randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 * interval \'1 hour\'))', [hashToken(token), user.id, SESSION_HOURS]);
      await pool.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,ip_address) VALUES($1,$2,$3,$4,$5)', [user.id, 'login_success', 'app_users', user.id, req.ip || null]);
      res.cookie(SESSION_COOKIE, token, cookieOptions());
      return res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role } });
    } catch { return res.status(500).json({ error: 'Unable to sign in.' }); }
  });
  router.get('/me', async (req, res) => {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
      const result = await pool.query('SELECT u.id,u.username,u.display_name,u.role FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true', [hashToken(token)]);
      if (!result.rows[0]) return res.status(401).json({ error: 'Session expired. Sign in again.' });
      return res.json({ user: { id: result.rows[0].id, username: result.rows[0].username, displayName: result.rows[0].display_name, role: result.rows[0].role } });
    } catch { return res.status(500).json({ error: 'Unable to verify session.' }); }
  });
  router.post('/logout', async (req, res) => {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) { try { await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hashToken(token)]); } catch { return res.status(500).json({ error: 'Unable to sign out.' }); } }
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.APP_ENV === 'production', path: '/' });
    return res.json({ ok: true });
  });
  return router;
}

export function requireRole(pool: Pool, allowed: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
      const result = await pool.query('SELECT u.id,u.role FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true', [hashToken(token)]);
      const user = result.rows[0];
      if (!user) return res.status(401).json({ error: 'Session expired.' });
      if (!allowed.includes(user.role)) return res.status(403).json({ error: 'Insufficient permissions.' });
      res.locals.user = user;
      return next();
    } catch { return res.status(500).json({ error: 'Unable to authorize request.' }); }
  };
}
