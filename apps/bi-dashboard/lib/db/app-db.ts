// Connection pool for the app's OWN database (bi_app) -- fully separate from
// the read-only `ecommerce` business database used by scripts/readonly-api.mjs.
// This pool is read-WRITE by design: it stores users, sessions, chat history,
// and generated reports. It must never be pointed at `ecommerce`.
import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getAppDb(): mysql.Pool {
  if (pool) return pool;

  pool = mysql.createPool({
    host: process.env.DB_APP_HOST ?? 'localhost',
    port: Number(process.env.DB_APP_PORT ?? 3306),
    database: process.env.DB_APP_NAME ?? 'bi_app',
    user: process.env.DB_APP_USER ?? 'bi_app_user',
    password: process.env.DB_APP_PASSWORD ?? '',
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
  });

  return pool;
}
