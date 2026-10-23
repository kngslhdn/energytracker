import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'energytracker-api', database: 'connected' }); }
  catch { res.status(503).json({ ok: false, service: 'energytracker-api', database: 'unavailable' }); }
});
app.get('/api/meters', async (_req, res) => {
  try { const result = await pool.query('SELECT id, code, name, utility_type, unit, multiplier, is_active FROM meters WHERE is_active = true ORDER BY code'); res.json(result.rows); }
  catch { res.status(500).json({ error: 'Unable to load meters. Apply the database migration first.' }); }
});
app.listen(port, '0.0.0.0', () => console.log(`EnergyTracker API listening on ${port}`));
