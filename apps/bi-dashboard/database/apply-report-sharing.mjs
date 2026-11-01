// Run once from apps/bi-dashboard with: npm run db:report-sharing
// Uses the configured schema administrator because the runtime DB user must
// not have CREATE or ALTER privileges.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(directory, '..', '.env.local');
if (fs.existsSync(envPath)) (await import('dotenv')).config({ path: envPath });

const connection = await mysql.createConnection({
  host: process.env.DB_APP_HOST ?? 'localhost',
  port: Number(process.env.DB_APP_PORT ?? 3306),
  database: process.env.DB_APP_NAME ?? 'bi_app',
  user: process.env.SCHEMA_ADMIN_USER ?? process.env.DB_APP_USER ?? 'bi_app_user',
  password: process.env.SCHEMA_ADMIN_PASSWORD ?? process.env.DB_APP_PASSWORD ?? '',
  multipleStatements: true,
});

try {
  // Create base report tables on a fresh install, then upgrade an existing
  // installation to the new sharing columns/tables.
  await connection.query(fs.readFileSync(path.join(directory, 'report-designer-migration.sql'), 'utf8'));
  await connection.query(fs.readFileSync(path.join(directory, 'report-sharing-migration.sql'), 'utf8'));
  console.log('Report sharing schema applied successfully.');
} catch (error) {
  console.error('Report sharing schema failed. Set SCHEMA_ADMIN_USER and SCHEMA_ADMIN_PASSWORD for a MySQL account with ALTER/CREATE rights, then retry.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await connection.end();
}
