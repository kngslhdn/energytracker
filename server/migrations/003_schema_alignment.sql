-- Keep the schema compatible with the API's current insert/select statements.
-- Safe to apply more than once on an existing development database.
ALTER TABLE meters
  ADD COLUMN IF NOT EXISTS account_reference TEXT;

ALTER TABLE utility_rates
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES app_users(id);

ALTER TABLE meter_readings
  ADD COLUMN IF NOT EXISTS ocr_engine TEXT;

-- Useful indexes for review queues and effective-dated rates.
CREATE INDEX IF NOT EXISTS meter_readings_status_date_idx
  ON meter_readings(status, reading_date DESC);

CREATE INDEX IF NOT EXISTS utility_rates_scope_dates_idx
  ON utility_rates(meter_id, utility_type, unit, effective_from, effective_to);
