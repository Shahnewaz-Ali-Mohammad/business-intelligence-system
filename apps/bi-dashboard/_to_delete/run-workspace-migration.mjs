// One-off runner for the workspaces migration block in database/bi_app_schema.sql
// -- reuses the app's own mysql2 dependency instead of requiring the mysql
// CLI to be installed. Safe to re-run (every statement is IF NOT EXISTS /
// INSERT IGNORE), same guarantee as the rest of that file.
import 'dotenv/config';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const sqlText = fs.readFileSync(new URL('../database/bi_app_schema.sql', import.meta.url), 'utf-8');

const connection = await mysql.createConnection({
  host: process.env.DB_APP_HOST ?? 'localhost',
  port: Number(process.env.DB_APP_PORT ?? 3306),
  user: process.env.DB_APP_USER ?? 'bi_app_user',
  password: process.env.DB_APP_PASSWORD ?? '',
  database: process.env.DB_APP_NAME ?? 'bi_app',
  multipleStatements: true,
});

try {
  await connection.query(sqlText);
  console.log('[migrate] Applied bi_app_schema.sql successfully (including the workspaces migration).');
} finally {
  await connection.end();
}
