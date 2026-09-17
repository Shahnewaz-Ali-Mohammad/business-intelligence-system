// ============================================================================
// Syncs billGENIXDB.dbo.BillingMaster into FOUR warehouse fact tables:
// fact_billing, fact_collection, fact_refund, fact_adjustment.
//
// This is the most important sync in the whole system — it encodes the
// confirmed (not assumed) RefTypeID mapping from real production data.
// See db/warehouse-schema.sql header comment and
// the project's running decision-log doc, section 3.7, for how this was verified.
//
// BillingMaster is large (~12.4M rows at last check) and has UpdateDate +
// EntryDate columns, so this uses TRUE INCREMENTAL sync — never a full
// reload — pulling only rows changed since the last successful sync.
//
// BATCHED / PAGED READ: on a first run (no watermark yet) the incremental
// filter matches all ~12.4M rows. Pulling that many rows into memory in one
// query — and building a JS object for every one of them at once — blew the
// Node heap (confirmed: real "JavaScript heap out of memory" crash during
// the first real run). To fix this WITHOUT just papering over it with a
// bigger --max-old-space-size flag, rows are now paged using keyset
// pagination on SNID (which is confirmed to be the table's row identity —
// see the fk_pk_constraints finding), in batches of BATCH_SIZE. Each batch
// is mapped and upserted into Postgres immediately, then discarded, before
// the next batch is fetched — so memory usage stays flat regardless of
// table size.
// ============================================================================

import sql from 'mssql';
import { getSourcePool } from '../../config/db.mjs';
import { upsertRows } from '../lib/upsert.mjs';
import { getLastSyncedAt, recordSyncStart, recordSyncSuccess, recordSyncFailure } from '../lib/syncLog.mjs';

// RefTypeID -> which fact table + name, per the CONFIRMED mapping (not a guess).
const BILLING_REF_TYPES = new Map([
  [1, 'INV_OTC'],
  [2, 'INV_MRC'],
  [3, 'INV_SHIFT'],
  [7, 'INV_OTHERS'],
  [8, 'DIRECT_SELL'],
  [10, 'DownChg'],
]);
const COLLECTION_REF_TYPE = 4; // 'MR' = Money Receipt
const REFUND_REF_TYPE = 5;
const ADJUSTMENT_REF_TYPE = 6;

const SOURCE_TABLE_NAME = 'BillingMaster';
const BATCH_SIZE = 50000;

function mapBatch(rows) {
  const billingRows = [];
  const collectionRows = [];
  const refundRows = [];
  const adjustmentRows = [];

  for (const row of rows) {
    if (BILLING_REF_TYPES.has(row.RefTypeID)) {
      billingRows.push({
        source_snid: row.SNID,
        customer_id: row.CustomerID,
        ref_type_id: row.RefTypeID,
        ref_type_name: BILLING_REF_TYPES.get(row.RefTypeID),
        ref_date: row.RefDate,
        tran_id: row.TranID,
        amount: row.Debit ?? 0,
        pop_id: null, // BillingMaster has no POPId column — resolve via dim_customer join at query time instead
        package_id: row.BID,
      });
    } else if (row.RefTypeID === COLLECTION_REF_TYPE) {
      collectionRows.push({
        source_snid: row.SNID,
        customer_id: row.CustomerID,
        ref_date: row.RefDate,
        tran_id: row.TranID,
        tran_mode_id: row.TranModeID,
        tran_mode_name: null, // resolved from dim lookup, left null here intentionally
        amount: row.Credit ?? 0,
        pop_id: null, // same as above — no POPId on this source table
        // FIX 2026-09-17: row.BID was already being SELECTed for every row
        // (billing AND collection alike, see the shared query below) but
        // was only ever carried into billingRows above -- this object
        // simply never included it, even though the real value was sitting
        // in memory. Not a source-data gap, an ETL mapping omission.
        package_id: row.BID,
      });
    } else if (row.RefTypeID === REFUND_REF_TYPE) {
      refundRows.push({
        source_snid: row.SNID,
        customer_id: row.CustomerID,
        ref_date: row.RefDate,
        amount: row.Debit ?? 0, // NOTE: refunds are Debit in source, confirmed — not negative Credit
      });
    } else if (row.RefTypeID === ADJUSTMENT_REF_TYPE) {
      adjustmentRows.push({
        source_snid: row.SNID,
        customer_id: row.CustomerID,
        ref_date: row.RefDate,
        amount: row.Credit ?? 0,
      });
    }
    // RefTypeID 9 (DISCOUNT) and 11 (INV_Service) are confirmed to have
    // zero real rows in BillingMaster — deliberately not handled here.
    // RefTypeID 12 (INV_BONUS) has rows but both Debit/Credit are 0 in
    // every case seen so far — also not written to a fact table for now.
  }

  return { billingRows, collectionRows, refundRows, adjustmentRows };
}

export async function syncBillingMaster() {
  await recordSyncStart(SOURCE_TABLE_NAME);
  try {
    const lastSyncedAt = await getLastSyncedAt(SOURCE_TABLE_NAME);
    const pool = await getSourcePool('billGENIXDB');

    let lastSNID = 0;
    let totalWritten = 0;
    let totalRowsSeen = 0;
    let maxWatermark = lastSyncedAt || new Date(0);
    let batchNumber = 0;

    // Loop, pulling BATCH_SIZE rows at a time ordered by SNID > lastSNID,
    // until a batch comes back smaller than BATCH_SIZE (meaning we've hit
    // the end of the matching rows).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const request = pool.request();
      request.input('lastSNID', sql.Int, lastSNID);
      request.input('batchSize', sql.Int, BATCH_SIZE);

      let whereClause = `WHERE SNID > @lastSNID`;
      if (lastSyncedAt) {
        request.input('since', sql.DateTime, lastSyncedAt);
        whereClause += ` AND (EntryDate > @since OR UpdateDate > @since)`;
      }

      // NOTE: confirmed against real INFORMATION_SCHEMA.COLUMNS output —
      // BillingMaster has NO POPId column at all (an earlier guess assumed
      // it did). POP has to be resolved via a join to dim_customer at query
      // time instead. BID (package) IS a real column here, so it's captured
      // directly rather than left null.
      const result = await request.query(`
        SELECT TOP (@batchSize) SNID, CustomerID, RefTypeID, RefDate, TranID, TranModeID,
               Debit, Credit, BID, EntryDate, UpdateDate
        FROM dbo.BillingMaster
        ${whereClause}
        ORDER BY SNID
      `);

      const rows = result.recordset;
      if (!rows.length) break;

      batchNumber += 1;
      totalRowsSeen += rows.length;

      const { billingRows, collectionRows, refundRows, adjustmentRows } = mapBatch(rows);

      if (billingRows.length) totalWritten += await upsertRows('fact_billing', ['source_snid'], billingRows);
      if (collectionRows.length) totalWritten += await upsertRows('fact_collection', ['source_snid'], collectionRows);
      if (refundRows.length) totalWritten += await upsertRows('fact_refund', ['source_snid'], refundRows);
      if (adjustmentRows.length) totalWritten += await upsertRows('fact_adjustment', ['source_snid'], adjustmentRows);

      for (const row of rows) {
        const candidate = row.UpdateDate && row.UpdateDate > row.EntryDate ? row.UpdateDate : row.EntryDate;
        if (candidate && candidate > maxWatermark) maxWatermark = candidate;
      }

      console.log(`[ETL]     BillingMaster batch ${batchNumber}: ${rows.length} rows (total seen so far: ${totalRowsSeen})`);

      lastSNID = rows[rows.length - 1].SNID;
      if (rows.length < BATCH_SIZE) break;
    }

    await recordSyncSuccess(SOURCE_TABLE_NAME, { rowCount: totalWritten, newWatermark: maxWatermark });
    return { table: SOURCE_TABLE_NAME, rowCount: totalWritten };
  } catch (error) {
    await recordSyncFailure(SOURCE_TABLE_NAME, error);
    throw error;
  }
}
