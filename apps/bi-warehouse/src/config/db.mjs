// ============================================================================
// Database connection config.
//
// Two separate connections on purpose, matching the layer boundary from the
// architecture doc: the SOURCE (production SQL Server, read-only) is only
// ever touched by the ETL layer (src/etl/*). Everything above the warehouse
// (semantic layer, services, MCP tools, dashboard) only ever talks to the
// WAREHOUSE (Postgres) — never the source directly. This is what makes the
// "swap the underlying database later" requirement possible: only this file
// and src/etl/* would need to change.
// ============================================================================

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// BUG FOUND (real run, 2026-09-15): plain `import 'dotenv/config'` only
// ever loads a file literally named `.env` in process.cwd(). This module
// is shared code -- imported both by apps/bi-warehouse (which uses a plain
// `.env`) and, cross-app, by apps/bi-dashboard's scripts/lib/dashboard-data.mjs
// (which follows the Next.js `.env.local` convention and has NO `.env`
// file at all). When bi-dashboard's readonly-api.mjs process ran as plain
// `node` (not through Next, which auto-loads `.env.local`), this line
// silently loaded nothing, WAREHOUSE_PG_* was undefined, and the Postgres
// connection failed with a confusing error far from the real cause.
// Fix: check both conventional filenames in the CURRENT process's cwd
// (not a hardcoded path to either app) and load whichever exist, `.env.local`
// first so it can override `.env` if a project ever has both.
for (const filename of ['.env.local', '.env']) {
  const candidate = path.resolve(process.cwd(), filename);
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
  }
}
import sql from 'mssql';
import pg from 'pg';

// --- Source: read-only connection to the production SQL Server ---
// Used ONLY by src/etl/* — nothing else should import this.
export const sourceConfig = {
  server: process.env.SQLSERVER_HOST,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true, // adjust based on the server's cert setup
  },
  // NOTE: read-only enforcement here is a safety net, not the real
  // guarantee — the real guarantee is that usr_mahi itself only has
  // SELECT rights on the server. This just makes misuse from our own
  // code loud and immediate instead of silently attempting a write.
  requestTimeout: 60000,
};

// BUG FOUND (real run): sql.connect(config) is node-mssql's GLOBAL singleton
// connection. Once it connects for one database (e.g. billGENIXDB, which
// every table except Tickets uses), calling sql.connect() again with a
// DIFFERENT database in the config does NOT switch databases — the library
// just hands back the already-open global pool. Every "TicketingDB" query
// that ran after a billGENIXDB one was silently querying the wrong database.
// This is why the tickets sync only ever returned a stray 0-1 rows despite
// TicketingDB.dbo.Tk_TicketInfoMaster having 173,061 real rows (confirmed
// directly against the source, not assumed).
//
// Fix: one real, isolated ConnectionPool PER database name, cached in a Map
// so repeated calls for the same database reuse a pool (no reconnect
// overhead) but different databases never share one.
const sourcePools = new Map();
export async function getSourcePool(database) {
  // database: 'billGENIXDB' or 'TicketingDB' — pass explicitly per call
  // so it's always clear which source DB a query is hitting.
  if (sourcePools.has(database)) {
    return sourcePools.get(database);
  }
  const config = { ...sourceConfig, database };
  const pool = await new sql.ConnectionPool(config).connect();
  sourcePools.set(database, pool);
  return pool;
}

// --- Destination: the BI warehouse (Postgres) ---
// Used by the ETL layer to WRITE, and by the semantic/services layer to READ.
const warehousePool = new pg.Pool({
  host: process.env.WAREHOUSE_PG_HOST,
  port: Number(process.env.WAREHOUSE_PG_PORT || 5432),
  database: process.env.WAREHOUSE_PG_DATABASE,
  user: process.env.WAREHOUSE_PG_USER,
  password: process.env.WAREHOUSE_PG_PASSWORD,
  max: 10,
});

export function getWarehousePool() {
  return warehousePool;
}
