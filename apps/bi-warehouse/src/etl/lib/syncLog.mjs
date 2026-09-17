// ============================================================================
// etl_sync_log helpers.
//
// Every table sync reads its watermark (last successful sync time) before
// pulling, and writes success/failure after. A FAILED table's watermark
// does NOT advance, so the next daily run retries it from the same point
// instead of silently skipping missed data. This is the mechanism described
// in the project doc under "ETL sync mechanics."
// ============================================================================

import { getWarehousePool } from '../../config/db.mjs';

export async function getLastSyncedAt(sourceTable) {
  const pool = getWarehousePool();
  const { rows } = await pool.query(
    `SELECT last_synced_at FROM etl_sync_log WHERE source_table = $1`,
    [sourceTable]
  );
  return rows[0]?.last_synced_at ?? null; // null = never synced -> caller should do a full pull
}

export async function recordSyncStart(sourceTable) {
  const pool = getWarehousePool();
  await pool.query(
    `INSERT INTO etl_sync_log (source_table, last_run_started_at, last_run_status)
     VALUES ($1, now(), 'running')
     ON CONFLICT (source_table)
     DO UPDATE SET last_run_started_at = now(), last_run_status = 'running'`,
    [sourceTable]
  );
}

export async function recordSyncSuccess(sourceTable, { rowCount, newWatermark }) {
  const pool = getWarehousePool();
  await pool.query(
    `UPDATE etl_sync_log
     SET last_synced_at = $2,
         last_run_finished_at = now(),
         last_run_status = 'success',
         last_run_row_count = $3,
         last_error = NULL
     WHERE source_table = $1`,
    [sourceTable, newWatermark, rowCount]
  );
}

export async function recordSyncFailure(sourceTable, error) {
  const pool = getWarehousePool();
  // Deliberately does NOT touch last_synced_at — that's the whole point:
  // a failed run must not advance the watermark, so next run retries
  // from the same point instead of silently losing data.
  await pool.query(
    `UPDATE etl_sync_log
     SET last_run_finished_at = now(),
         last_run_status = 'failed',
         last_error = $2
     WHERE source_table = $1`,
    [sourceTable, String(error?.message || error)]
  );
}
