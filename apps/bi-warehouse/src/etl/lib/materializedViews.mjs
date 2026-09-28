// ============================================================================
// Refreshes warehouse materialized views after a sync run -- keeps the
// pre-aggregated rollups (see database/warehouse-schema.sql PATCH 3) in
// step with whatever BillingMaster just synced in, without ever making a
// user-facing report request pay the cost of the raw join+aggregate itself.
// ============================================================================

import { getWarehousePool } from '../../config/db.mjs';

const MATERIALIZED_VIEWS = ['mart_pop_daily_financials'];

export async function refreshMaterializedViews() {
  const pool = getWarehousePool();
  const results = [];
  for (const viewName of MATERIALIZED_VIEWS) {
    const startedAt = Date.now();
    try {
      // CONCURRENTLY requires the unique index created alongside the view
      // (see the schema patch) -- without it this falls back to a full
      // lock that would block reports mid-refresh, which defeats half the
      // point of pre-aggregating in the first place.
      await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
      results.push({ viewName, status: 'success', ms: Date.now() - startedAt });
    } catch (error) {
      // A refresh failure must never abort the whole ETL run (same
      // per-step isolation as every other sync step in sync.mjs) -- the
      // view just serves last night's numbers until the next successful
      // refresh, which is a staleness problem, not a correctness one.
      results.push({ viewName, status: 'failed', error: error.message, ms: Date.now() - startedAt });
    }
  }
  const rowCount = results.filter((r) => r.status === 'success').length;
  return { rowCount, results };
}
