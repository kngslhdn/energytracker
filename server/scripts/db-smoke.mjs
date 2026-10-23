import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for the database migration smoke test.');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const migrationDirectory = path.resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error('No SQL migrations were found.');
  for (const file of files) {
    const sql = await readFile(path.join(migrationDirectory, file), 'utf8');
    await client.query(sql);
    process.stdout.write(`Applied ${file}\n`);
  }

  const requiredTables = [
    'app_users', 'auth_sessions', 'meters', 'utility_rates', 'meter_readings',
    'checklist_templates', 'checklist_items', 'checklist_submissions',
    'checklist_responses', 'audit_logs'
  ];
  const tableResult = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  const foundTables = new Set(tableResult.rows.map(row => row.table_name));
  const missingTables = requiredTables.filter(name => !foundTables.has(name));
  if (missingTables.length) throw new Error(`Missing required tables: ${missingTables.join(', ')}`);

  const requiredColumns = [
    ['meters', 'account_reference'],
    ['utility_rates', 'created_by'],
    ['meter_readings', 'ocr_engine']
  ];
  for (const [tableName, columnName] of requiredColumns) {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [tableName, columnName]
    );
    if (!result.rowCount) throw new Error(`Missing required column: ${tableName}.${columnName}`);
  }

  // Re-run the alignment migration to verify its idempotence.
  await client.query(await readFile(path.join(migrationDirectory, '003_schema_alignment.sql'), 'utf8'));
  process.stdout.write('Database migration smoke test passed.\n');
} finally {
  await client.end();
}
