import { Router } from 'express';
import type { Pool } from 'pg';
import { requireRole } from './auth.js';

const utilities = new Set(['electricity','water','gas','other']);
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(new Date(v + 'T00:00:00Z').getTime()) && new Date(v + 'T00:00:00Z').toISOString().slice(0,10) === v;
const decimal = (v: unknown, allowZero = true) => { if (typeof v !== 'string' && typeof v !== 'number') return null; const s=String(v); if(!/^\d{1,14}(\.\d{1,8})?$/.test(s)) return null; const n=Number(s); return Number.isFinite(n) && (allowZero ? n>=0 : n>0) ? s : null; };

export function configurationRouter(pool: Pool) {
 const router=Router();
 router.get('/meters',requireRole(pool,['engineer','supervisor','admin']),async(_req,res)=>{
  try { const r=await pool.query('SELECT id,code,name,utility_type,location_id,unit,multiplier,supplier_name,account_reference,baseline_reading,rollover_value,is_active,created_at FROM meters ORDER BY code'); return res.json(r.rows); }
  catch { return res.status(500).json({error:'Unable to load meter register.'}); }
 });
 router.post('/meters',requireRole(pool,['admin']),async(req,res)=>{
  const {code,name,utilityType,locationId,unit,multiplier,supplierName,accountReference,baselineReading,rolloverValue}=req.body||{};
  const factor=decimal(multiplier ?? '1',false); const baseline=baselineReading===''||baselineReading===undefined||baselineReading===null?null:decimal(baselineReading); const rollover=rolloverValue===''||rolloverValue===undefined||rolloverValue===null?null:decimal(rolloverValue);
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{2,40}$/.test(code)||typeof name!=='string'||name.trim().length<2||name.length>160||typeof utilityType!=='string'||!utilities.has(utilityType)||typeof unit!=='string'||unit.trim().length<1||unit.length>24||factor===null||baselineReading!==undefined&&baselineReading!==''&&baseline===null||rolloverValue!==undefined&&rolloverValue!==''&&rollover===null) return res.status(400).json({error:'Provide a valid meter code, name, utility type, unit, multiplier, and optional baseline/rollover.'});
  try {
   const result=await pool.query('INSERT INTO meters(code,name,utility_type,location_id,unit,multiplier,supplier_name,account_reference,baseline_reading,rollover_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,code,name,utility_type,location_id,unit,multiplier,supplier_name,account_reference,baseline_reading,rollover_value,is_active',[code.toUpperCase(),name.trim(),utilityType,locationId||null,unit.trim(),factor,typeof supplierName==='string'?supplierName.trim()||null:null,typeof accountReference==='string'?accountReference.trim()||null:null,baseline,rollover]);
   await pool.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,after_data,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[res.locals.user.id,'meter_created','meters',result.rows[0].id,JSON.stringify(result.rows[0]),req.ip||null]);
   return res.status(201).json({meter:result.rows[0]});
  } catch(error) { if((error as {code?:string}).code==='23505')return res.status(409).json({error:'Meter code already exists.'}); return res.status(500).json({error:'Unable to create meter.'}); }
 });
 router.get('/rates',requireRole(pool,['engineer','supervisor','admin']),async(_req,res)=>{
  try { const r=await pool.query('SELECT id,meter_id,utility_type,unit,currency,rate_per_unit,effective_from,effective_to FROM utility_rates ORDER BY effective_from DESC LIMIT 500'); return res.json(r.rows); }
  catch { return res.status(500).json({error:'Unable to load utility rates.'}); }
 });
 router.post('/rates',requireRole(pool,['admin']),async(req,res)=>{
  const {meterId,utilityType,unit,currency,ratePerUnit,effectiveFrom,effectiveTo}=req.body||{};
  const rate=decimal(ratePerUnit); const scopeUtility=typeof utilityType==='string'&&utilities.has(utilityType)?utilityType:null;
  if((!meterId&&!scopeUtility)||(meterId&&typeof meterId!=='string')||typeof unit!=='string'||!unit.trim()||unit.length>24||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)||rate===null||!validDate(effectiveFrom)||(effectiveTo!==undefined&&effectiveTo!==null&&effectiveTo!==''&&(!validDate(effectiveTo)||effectiveTo<effectiveFrom)))return res.status(400).json({error:'Provide a valid meter or utility scope, unit, ISO currency, rate, and effective date range.'});
  const end=effectiveTo||null;
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   if(meterId){const m=await client.query('SELECT id,utility_type,unit FROM meters WHERE id=$1 AND is_active=true FOR UPDATE',[meterId]);if(!m.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Active meter not found.'});}if(m.rows[0].unit!==unit.trim()){await client.query('ROLLBACK');return res.status(400).json({error:'Rate unit must match the registered meter unit.'});}}
   const overlap=await client.query(
    `SELECT id FROM utility_rates WHERE ((meter_id=$1 AND $1::uuid IS NOT NULL) OR (meter_id IS NULL AND $1::uuid IS NULL AND utility_type=$2))
      AND unit=$3 AND effective_from<=COALESCE($4::date,'9999-12-31'::date) AND COALESCE(effective_to,'9999-12-31'::date)>=$5::date LIMIT 1 FOR UPDATE`,
    [meterId||null,scopeUtility,unit.trim(),end,effectiveFrom]);
   if(overlap.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'This rate overlaps an existing effective period for the same scope and unit.'});}
   const result=await client.query('INSERT INTO utility_rates(meter_id,utility_type,unit,currency,rate_per_unit,effective_from,effective_to,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,meter_id,utility_type,unit,currency,rate_per_unit,effective_from,effective_to',[meterId||null,meterId?null:scopeUtility,unit.trim(),currency,rate,effectiveFrom,end,res.locals.user.id]);
   await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,after_data,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[res.locals.user.id,'utility_rate_created','utility_rates',result.rows[0].id,JSON.stringify(result.rows[0]),req.ip||null]);
   await client.query('COMMIT');return res.status(201).json({rate:result.rows[0]});
  } catch(error) {try{await client.query('ROLLBACK')}catch{} return res.status(500).json({error:'Unable to create utility rate.'});} finally{client.release();}
 });
 return router;
}
