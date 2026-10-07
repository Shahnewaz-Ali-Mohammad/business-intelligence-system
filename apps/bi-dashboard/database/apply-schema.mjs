// Run this from apps/bi-dashboard with: node database/apply-schema.mjs
// Applies database/bi_app_schema.sql (the whole file, including every past
// migration) against the bi_app database using the same mysql2 dependency
// and .env.local credentials the app itself uses -- no separate mysql CLI
// install required. Every migration in that file is written to be safe to
// re-run (IF NOT EXISTS / column-existence checks), so running this
// against a database that already has some of these columns is a no-op
// for those parts and only adds what's actually missing.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envLocalPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) {
  const { config } = await import('dotenv');
  config({ path: envLocalPath });
}

// ALTER TABLE/CREATE TABLE need admin privileges that the app's own
// day-to-day DB_APP_USER (bi_app_user) deliberately does NOT have -- that
// user is scoped to normal query privileges only, which is correct for
// the running app, but means it can't apply schema changes itself (a real
// "Access denied" from MySQL, not a bug in this script). Set
// SCHEMA_ADMIN_USER/SCHEMA_ADMIN_PASSWORD to a MySQL user that has ALTER
// rights on bi_app (root, or whatever admin account first created this
// database) when running this -- it falls back to DB_APP_USER only if
// those aren't set, so a misconfigured env fails the same honest way it
// just did rather than silently doing nothing.
const conn = await mysql.createConnection({
  host: process.env.DB_APP_HOST ?? 'localhost',
  port: Number(process.env.DB_APP_PORT ?? 3306),
  database: process.env.DB_APP_NAME ?? 'bi_app',
  user: process.env.SCHEMA_ADMIN_USER ?? process.env.DB_APP_USER ?? 'bi_app_user',
  password: process.env.SCHEMA_ADMIN_PASSWORD ?? process.env.DB_APP_PASSWORD ?? '',
  multipleStatements: true,
});

const sql = fs.readFileSync(path.join(__dirname, 'bi_app_schema.sql'), 'utf8');
try {
  await conn.query(sql);
  console.log('Schema applied successfully.');
} catch (err) {
  console.error('Schema apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
