// Installs the role-based access tables (database/access-control-migration.sql).
// Run once from apps/bi-dashboard:  npm run db:access
// Like apply-schema.mjs it needs an account that may CREATE tables: set
// SCHEMA_ADMIN_USER / SCHEMA_ADMIN_PASSWORD (for example root). It then
// grants the app's own user read/write on the new tables.
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) (await import('dotenv')).config({ path: envLocalPath });

const database = process.env.DB_APP_NAME ?? 'bi_app';
const appUser = process.env.DB_APP_USER ?? 'bi_app_user';
const conn = await mysql.createConnection({
  host: process.env.DB_APP_HOST ?? 'localhost',
  port: Number(process.env.DB_APP_PORT ?? 3306),
  database,
  user: process.env.SCHEMA_ADMIN_USER ?? 'root',
  password: process.env.SCHEMA_ADMIN_PASSWORD ?? '',
  multipleStatements: true,
});
try {
  await conn.query(fs.readFileSync(path.join(__dirname, 'access-control-migration.sql'), 'utf8'));
  for (const table of ['user_status', 'departments', 'user_roles', 'user_departments', 'invitations', 'data_policies', 'audit_log', 'user_mfa', 'pending_logins']) {
    await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.\`${table}\` TO ?@'localhost'`, [appUser]).catch((error) => {
      console.warn(`Could not grant ${appUser} access to ${table}: ${error.message}. Grant SELECT, INSERT, UPDATE, DELETE on it by hand.`);
    });
  }
  console.log('Access control installed. Existing users are Admin + CEO; manage them on the Admin page.');
} catch (error) {
  console.error('Access control install failed:', error.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
