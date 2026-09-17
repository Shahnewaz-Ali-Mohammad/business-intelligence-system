// ============================================================================
// Applies database/warehouse-schema.sql to the warehouse Postgres database.
// Run with: npm run migrate
//
// Safe to run multiple times — every statement in the schema file uses
// CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so re-running
// this after the schema evolves just adds what's missing.
// ============================================================================

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', '..', '..', 'database', 'warehouse-schema.sql');

async function migrate() {
  const sqlText = readFileSync(schemaPath, 'utf-8');

  const client = new pg.Client({
    host: process.env.WAREHOUSE_PG_HOST,
    port: Number(process.env.WAREHOUSE_PG_PORT || 5432),
    database: process.env.WAREHOUSE_PG_DATABASE,
    user: process.env.WAREHOUSE_PG_USER,
    password: process.env.WAREHOUSE_PG_PASSWORD,
  });

  await client.connect();
  console.log(`[migrate] Connected to ${process.env.WAREHOUSE_PG_DATABASE}@${process.env.WAREHOUSE_PG_HOST}`);
  console.log(`[migrate] Applying ${schemaPath}`);

  try {
    await client.query(sqlText);
    console.log('[migrate] Schema applied successfully.');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  process.exit(1);
});
