import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { requireRole } from './auth.js';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const storageRoot = path.resolve(process.env.STORAGE_ROOT || './storage');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
type UploadRequest = Request & { file?: Express.Multer.File };
function validImage(buffer: Buffer, mime: string) {
  if (mime === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
function parseDecimal(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d{1,14}(\.\d{1,6})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? text : null;
}
function parseDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function meterReadingRouter(pool: Pool) {
  const router = Router();
  router.get('/', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (req, res) => {
    const date = typeof req.query.date === 'string' && parseDate(req.query.date) ? req.query.date : null;
    try {
      const result = await pool.query(
        `SELECT r.id, r.meter_id, m.code AS meter_code, m.name AS meter_name, m.utility_type, m.unit,
          r.reading_date, r.recorded_at, r.verified_reading, r.ocr_reading, r.ocr_confidence,
          r.previous_reading, r.consumption, r.estimated_cost, r.currency, r.status
         FROM meter_readings r JOIN meters m ON m.id = r.meter_id
         WHERE ($1::date IS NULL OR r.reading_date = $1::date)
         ORDER BY r.reading_date DESC, m.code LIMIT 250`, [date]);
      return res.json(result.rows);
    } catch { return res.status(500).json({ error: 'Unable to load meter readings.' }); }
  });

  router.post('/', requireRole(pool, ['engineer', 'supervisor', 'admin']), upload.single('photo'), async (req: UploadRequest, res) => {
    const { meterId, readingDate, reading, ocrReading, ocrConfidence } = req.body || {};
    const verifiedReading = parseDecimal(reading);
    const detectedReading = ocrReading === undefined || ocrReading === '' ? null : parseDecimal(ocrReading);
    const confidence = ocrConfidence === undefined || ocrConfidence === '' ? null : Number(ocrConfidence);
    if (typeof meterId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meterId)) return res.status(400).json({ error: 'A valid meterId is required.' });
    if (!parseDate(readingDate)) return res.status(400).json({ error: 'readingDate must be a real YYYY-MM-DD date.' });
    if (verifiedReading === null) return res.status(400).json({ error: 'Enter a valid non-negative reading with up to 6 decimal places.' });
    if (ocrReading !== undefined && ocrReading !== '' && detectedReading === null) return res.status(400).json({ error: 'OCR reading is invalid.' });
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return res.status(400).json({ error: 'OCR confidence must be between 0 and 1.' });
    const photo = req.file;
    if (!photo) return res.status(400).json({ error: 'Meter photo is required.' });
    if (!validImage(photo.buffer, photo.mimetype)) return res.status(415).json({ error: 'Only valid JPEG, PNG, or WebP images are accepted.' });

    const client = await pool.connect();
    let storedPath = '';
    try {
      await client.query('BEGIN');
      const meterResult = await client.query(
        'SELECT id, code, utility_type, unit, multiplier, baseline_reading, rollover_value FROM meters WHERE id=$1 AND is_active=true FOR UPDATE',
        [meterId]);
      const meter = meterResult.rows[0];
      if (!meter) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active meter not found.' }); }

      const existing = await client.query('SELECT id FROM meter_readings WHERE meter_id=$1 AND reading_date=$2', [meterId, readingDate]);
      if (existing.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'A reading already exists for this meter and date. Use the audited correction workflow instead.' }); }

      const previousResult = await client.query(
        `SELECT verified_reading, reading_date FROM meter_readings
         WHERE meter_id=$1 AND reading_date < $2 AND status IN ('verified','baseline')
         ORDER BY reading_date DESC LIMIT 1`, [meterId, readingDate]);
      const previous = previousResult.rows[0];
      const previousValue = previous ? String(previous.verified_reading) : (meter.baseline_reading === null ? null : String(meter.baseline_reading));
      const hasBaseline = previousValue !== null;
      let consumption: string | null = null;
      let status: 'baseline' | 'pending_review' | 'requires_review' = 'pending_review';
      if (!hasBaseline) status = 'baseline';
      else if (Number(verifiedReading) < Number(previousValue)) status = 'requires_review';
      else {
        const multiplier = Number(meter.multiplier);
        const quantity = (Number(verifiedReading) - Number(previousValue)) * multiplier;
        if (!Number.isFinite(quantity) || !Number.isFinite(multiplier) || multiplier <= 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: 'Meter multiplier or calculated consumption is invalid.' });
        }
        consumption = quantity.toFixed(6);
      }

      const rateResult = await client.query(
        `SELECT id, rate_per_unit, currency FROM utility_rates
         WHERE (meter_id=$1 OR (meter_id IS NULL AND utility_type=$2))
           AND unit=$3 AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date)
         ORDER BY (meter_id IS NOT NULL) DESC, effective_from DESC LIMIT 1`,
        [meterId, meter.utility_type, meter.unit, readingDate]);
      const rate = rateResult.rows[0];
      let cost: string | null = null;
      if (consumption !== null && rate) {
        const amount = Number(consumption) * Number(rate.rate_per_unit);
        if (Number.isFinite(amount)) cost = amount.toFixed(2);
      }
      if (status === 'pending_review' && !rate) status = 'requires_review';
      const key = `${new Date().getUTCFullYear()}/${randomUUID()}`;
      storedPath = path.join(storageRoot, key);
      await mkdir(path.dirname(storedPath), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, photo.buffer, { flag: 'wx', mode: 0o600 });
      const sha = createHash('sha256').update(photo.buffer).digest('hex');
      const actorId = res.locals.user?.id || null;
      const inserted = await client.query(
        `INSERT INTO meter_readings
         (meter_id,reading_date,recorded_by,photo_storage_key,photo_sha256,ocr_reading,ocr_confidence,ocr_engine,
          verified_reading,previous_reading,multiplier_snapshot,rate_id,rate_snapshot,currency,consumption,estimated_cost,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id,meter_id,reading_date,verified_reading,previous_reading,consumption,estimated_cost,currency,status,recorded_at`,
        [meterId, readingDate, actorId, key, sha, detectedReading, confidence, detectedReading === null ? null : 'tesseract.js-browser',
          verifiedReading, previousValue, meter.multiplier, rate?.id || null, rate?.rate_per_unit || null, rate?.currency || null,
          consumption, cost, status]);
      await client.query(
        'INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,after_data,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [actorId, 'meter_reading_created', 'meter_readings', inserted.rows[0].id,
          JSON.stringify({ meterId, readingDate, verifiedReading, previousReading: previousValue, consumption, estimatedCost: cost, status, photoSha256: sha }), req.ip || null]);
      await client.query('COMMIT');
      return res.status(201).json({ reading: inserted.rows[0], message: status === 'baseline' ? 'Saved as baseline; no consumption was invented.' : status === 'requires_review' ? 'Saved for review because a rate is missing or the reading decreased.' : 'Saved for supervisor review.' });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      if (storedPath) { try { await readFile(storedPath); const { unlink } = await import('node:fs/promises'); await unlink(storedPath); } catch { /* do not expose storage details */ } }
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'A reading already exists for this meter and date.' });
      return res.status(500).json({ error: 'Unable to save meter reading.' });
    } finally { client.release(); }
  });

  router.get('/:id/photo', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (req, res) => {
    const readingId = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(readingId)) return res.status(400).json({ error: 'Invalid reading id.' });
    try {
      const result = await pool.query('SELECT photo_storage_key FROM meter_readings WHERE id=$1', [readingId]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Reading not found.' });
      const key = String(result.rows[0].photo_storage_key);
      const target = path.resolve(storageRoot, key);
      if (!target.startsWith(storageRoot + path.sep)) return res.status(400).json({ error: 'Invalid storage key.' });
      const bytes = await readFile(target);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="meter-evidence"');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(bytes);
    } catch { return res.status(500).json({ error: 'Unable to retrieve private meter evidence.' }); }
  });
  return router;
}
