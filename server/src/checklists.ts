import { Router } from 'express';
import type { Pool } from 'pg';
import { requireRole } from './auth.js';

const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function checklistRouter(pool: Pool) {
  const router = Router();

  router.get('/options', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (_req, res) => {
    try {
      const [templates, shifts] = await Promise.all([
        pool.query(`SELECT id, name, version FROM checklist_templates WHERE is_active=true ORDER BY name, version DESC`),
        pool.query(`SELECT id, code, name, start_time, end_time FROM shifts WHERE is_active=true ORDER BY start_time, code`)
      ]);
      const itemResult = await pool.query(
        `SELECT i.id, i.template_id, i.area, i.equipment, i.label, i.input_type, i.unit,
                i.min_value, i.max_value, i.is_required, i.instructions, i.sort_order
         FROM checklist_items i JOIN checklist_templates t ON t.id=i.template_id
         WHERE t.is_active=true ORDER BY i.template_id, i.sort_order, i.area, i.equipment`
      );
      return res.json({ templates: templates.rows, shifts: shifts.rows, items: itemResult.rows });
    } catch {
      return res.status(500).json({ error: 'Unable to load checklist configuration.' });
    }
  });

  router.get('/', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (req, res) => {
    const date = typeof req.query.date === 'string' && validDate(req.query.date) ? req.query.date : null;
    try {
      const result = await pool.query(
        `SELECT s.id, s.shift_date, s.status, s.submitted_at, s.reviewed_at,
                t.name AS template_name, t.version AS template_version,
                sh.name AS shift_name, u.display_name AS submitted_by,
                reviewer.display_name AS reviewed_by,
                count(r.id)::int AS response_count,
                count(r.id) FILTER (WHERE r.finding IS NOT NULL AND r.finding <> '')::int AS findings_count
         FROM checklist_submissions s
         JOIN checklist_templates t ON t.id=s.template_id
         JOIN shifts sh ON sh.id=s.shift_id
         JOIN app_users u ON u.id=s.submitted_by
         LEFT JOIN app_users reviewer ON reviewer.id=s.reviewed_by
         LEFT JOIN checklist_responses r ON r.submission_id=s.id
         WHERE ($1::date IS NULL OR s.shift_date=$1::date)
         GROUP BY s.id,t.name,t.version,sh.name,u.display_name,reviewer.display_name
         ORDER BY s.shift_date DESC,s.submitted_at DESC LIMIT 200`, [date]);
      return res.json(result.rows);
    } catch {
      return res.status(500).json({ error: 'Unable to load checklist submissions.' });
    }
  });

  router.get('/:id', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid submission id.' });
    try {
      const submission = await pool.query(
        `SELECT s.*, t.name AS template_name, sh.name AS shift_name, u.display_name AS submitted_by
         FROM checklist_submissions s JOIN checklist_templates t ON t.id=s.template_id
         JOIN shifts sh ON sh.id=s.shift_id JOIN app_users u ON u.id=s.submitted_by WHERE s.id=$1`, [id]);
      if (!submission.rows[0]) return res.status(404).json({ error: 'Checklist submission not found.' });
      const responses = await pool.query(
        `SELECT r.*, i.area, i.equipment, i.label, i.input_type, i.unit, i.is_required, i.instructions, i.sort_order
         FROM checklist_responses r JOIN checklist_items i ON i.id=r.item_id
         WHERE r.submission_id=$1 ORDER BY i.sort_order,i.area,i.equipment`, [id]);
      return res.json({ submission: submission.rows[0], responses: responses.rows });
    } catch {
      return res.status(500).json({ error: 'Unable to load checklist submission.' });
    }
  });

  router.post('/', requireRole(pool, ['engineer', 'supervisor', 'admin']), async (req, res) => {
    const { templateId, shiftId, shiftDate, responses } = req.body || {};
    const userId = res.locals.user?.id;
    if (typeof templateId !== 'string' || !/^[0-9a-f-]{36}$/i.test(templateId) ||
        typeof shiftId !== 'string' || !/^[0-9a-f-]{36}$/i.test(shiftId) ||
        !validDate(shiftDate) || !Array.isArray(responses) || responses.length < 1 || responses.length > 200) {
      return res.status(400).json({ error: 'Provide a template, shift, valid shift date, and checklist responses.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const [template, shift, items] = await Promise.all([
        client.query('SELECT id FROM checklist_templates WHERE id=$1 AND is_active=true FOR SHARE', [templateId]),
        client.query('SELECT id FROM shifts WHERE id=$1 AND is_active=true FOR SHARE', [shiftId]),
        client.query(
          `SELECT id, input_type, is_required, min_value, max_value FROM checklist_items
           WHERE template_id=$1 ORDER BY sort_order`, [templateId])
      ]);
      if (!template.rows[0] || !shift.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The selected checklist template or shift is inactive or unavailable.' });
      }
      const itemMap = new Map<string, any>(items.rows.map((item: any) => [item.id, item]));
      const seen = new Set<string>();
      const normalized: any[] = [];
      for (const response of responses) {
        if (!response || typeof response.itemId !== 'string' || seen.has(response.itemId) || !itemMap.has(response.itemId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each response must reference a unique item in the selected template.' });
        }
        seen.add(response.itemId);
        const item = itemMap.get(response.itemId);
        const value = response.value;
        const remarks = typeof response.remarks === 'string' ? response.remarks.trim().slice(0, 2000) : null;
        const finding = typeof response.finding === 'string' ? response.finding.trim().slice(0, 2000) : null;
        const correctiveAction = typeof response.correctiveAction === 'string' ? response.correctiveAction.trim().slice(0, 2000) : null;
        let numericValue: string | null = null;
        let textValue: string | null = null;
        let booleanValue: boolean | null = null;
        let statusValue: string | null = null;
        let missing = value === undefined || value === null || value === '';
        if (item.input_type === 'numeric' && !missing) {
          const text = String(value);
          if (!/^-?\d{1,14}(\.\d{1,6})?$/.test(text) || !Number.isFinite(Number(text))) {
            await client.query('ROLLBACK'); return res.status(400).json({ error: `A numeric value is required for checklist item ${response.itemId}.` });
          }
          numericValue = text;
          if (item.min_value !== null && Number(text) < Number(item.min_value) || item.max_value !== null && Number(text) > Number(item.max_value)) {
            if (!finding) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'A value outside the configured range must include a finding for review.' });
            }
          }
        } else if (item.input_type === 'boolean' && !missing) {
          if (typeof value !== 'boolean') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Boolean checklist values must be true or false.' }); }
          booleanValue = value;
        } else if (['text', 'select'].includes(item.input_type) && !missing) {
          if (typeof value !== 'string' || value.trim().length > 2000) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Checklist text value is invalid.' }); }
          textValue = value.trim();
        } else if (item.input_type === 'status' && !missing) {
          if (typeof value !== 'string' || !['normal', 'attention', 'abnormal', 'not_applicable'].includes(value)) {
            await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose a valid checklist status.' });
          }
          statusValue = value;
        } else if (item.input_type === 'photo' && !missing) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Photo checklist responses require the dedicated private-upload workflow, which is not enabled yet.' });
        }
        if (item.is_required && missing) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Complete all required checklist items before submitting.' });
        }
        normalized.push({ itemId: response.itemId, numericValue, textValue, booleanValue, statusValue, remarks, finding, correctiveAction });
      }
      for (const item of items.rows) {
        if (item.is_required && !seen.has(item.id)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'A required checklist item is missing from the submission.' });
        }
      }
      const created = await client.query(
        `INSERT INTO checklist_submissions(template_id,shift_id,shift_date,submitted_by,status)
         VALUES($1,$2,$3,$4,'submitted') RETURNING id,template_id,shift_id,shift_date,submitted_by,submitted_at,status`,
        [templateId, shiftId, shiftDate, userId]);
      for (const item of normalized) {
        await client.query(
          `INSERT INTO checklist_responses(submission_id,item_id,numeric_value,text_value,boolean_value,status_value,remarks,finding,corrective_action)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [created.rows[0].id,item.itemId,item.numericValue,item.textValue,item.booleanValue,item.statusValue,item.remarks,item.finding,item.correctiveAction]);
      }
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,after_data,ip_address)
         VALUES($1,'checklist_submitted','checklist_submissions',$2,$3::jsonb,$4)`,
        [userId,created.rows[0].id,JSON.stringify({templateId,shiftId,shiftDate,responseCount:normalized.length}),req.ip || null]);
      await client.query('COMMIT');
      return res.status(201).json({ submission: created.rows[0], message: 'Checklist submitted successfully.' });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'A submission already exists for this template, shift, and date.' });
      return res.status(500).json({ error: 'Unable to submit checklist.' });
    } finally {
      client.release();
    }
  });

  router.post('/:id/review', requireRole(pool, ['supervisor', 'admin']), async (req, res) => {
    const id = String(req.params.id);
    const { decision, note } = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(id) || !['approved', 'needs_action'].includes(decision)) {
      return res.status(400).json({ error: 'Provide a valid submission id and decision: approved or needs_action.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE checklist_submissions SET status=$2,reviewed_by=$3,reviewed_at=now()
         WHERE id=$1 AND status='submitted' RETURNING id,status,reviewed_by,reviewed_at`,
        [id,decision,res.locals.user.id]);
      if (!updated.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Submitted checklist not found or already reviewed.' }); }
      await client.query(
        `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,after_data,ip_address)
         VALUES($1,'checklist_reviewed','checklist_submissions',$2,$3::jsonb,$4)`,
        [res.locals.user.id,id,JSON.stringify({decision,note:typeof note==='string'?note.trim().slice(0,2000):null}),req.ip || null]);
      await client.query('COMMIT');
      return res.json({ submission: updated.rows[0], message: 'Checklist review saved.' });
    } catch {
      try { await client.query('ROLLBACK'); } catch {}
      return res.status(500).json({ error: 'Unable to review checklist.' });
    } finally { client.release(); }
  });

  return router;
}
