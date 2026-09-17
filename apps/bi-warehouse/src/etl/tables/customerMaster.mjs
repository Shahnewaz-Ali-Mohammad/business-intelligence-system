// ============================================================================
// Syncs billGENIXDB.dbo.CustomerMaster into dim_customer.
//
// billGENIXDB is treated as the single source of truth for customer
// identity (per the project decision — TicketingDB.CustomerMaster is
// assumed to be a synced copy, NOT independently verified yet; see open
// item in the project doc). CustomerMaster is a moderate-size table
// (~386K rows at last check) with EntryDate/UpdateDate, so this also
// uses incremental sync.
// ============================================================================

import sql from 'mssql';
import { getSourcePool } from '../../config/db.mjs';
import { upsertRows } from '../lib/upsert.mjs';
import { getLastSyncedAt, recordSyncStart, recordSyncSuccess, recordSyncFailure } from '../lib/syncLog.mjs';

const SOURCE_TABLE_NAME = 'CustomerMaster';

export async function syncCustomerMaster() {
  await recordSyncStart(SOURCE_TABLE_NAME);
  try {
    const lastSyncedAt = await getLastSyncedAt(SOURCE_TABLE_NAME);
    const pool = await getSourcePool('billGENIXDB');

    const request = pool.request();
    let whereClause = '';
    if (lastSyncedAt) {
      request.input('since', sql.DateTime, lastSyncedAt);
      whereClause = `WHERE EntryDate > @since OR UpdateDate > @since`;
    }

    // NOTE: adjust the exact column list below once real column names for
    // POPId / BID (package) / StatusID are double-checked against a fresh
    // row sample — these names are taken from the schema dump, not from
    // an eyeballed row, so verify before relying on this in production.
    const result = await request.query(`
      SELECT CustomerID, CustomerName, POPId, BID AS PackageID, StatusID,
             ConnectionTypeId, ResidentTypeId, EntryDate, UpdateDate, ActivatedDate
      FROM dbo.CustomerMaster
      ${whereClause}
    `);

    const rows = result.recordset;
    if (!rows.length) {
      await recordSyncSuccess(SOURCE_TABLE_NAME, { rowCount: 0, newWatermark: lastSyncedAt || new Date() });
      return { table: SOURCE_TABLE_NAME, rowCount: 0 };
    }

    const mapped = rows.map((row) => ({
      customer_id: row.CustomerID,
      customer_name: row.CustomerName,
      pop_id: row.POPId,
      package_id: row.PackageID,
      status_id: row.StatusID,
      connection_type: row.ConnectionTypeId,
      resident_type: row.ResidentTypeId,
      entry_date: row.EntryDate,
      activated_date: row.ActivatedDate,
    }));

    const written = await upsertRows('dim_customer', ['customer_id'], mapped);

    const newWatermark = rows.reduce((max, row) => {
      const candidate = row.UpdateDate && row.UpdateDate > row.EntryDate ? row.UpdateDate : row.EntryDate;
      return candidate > max ? candidate : max;
    }, lastSyncedAt || new Date(0));

    await recordSyncSuccess(SOURCE_TABLE_NAME, { rowCount: written, newWatermark });
    return { table: SOURCE_TABLE_NAME, rowCount: written };
  } catch (error) {
    await recordSyncFailure(SOURCE_TABLE_NAME, error);
    throw error;
  }
}
