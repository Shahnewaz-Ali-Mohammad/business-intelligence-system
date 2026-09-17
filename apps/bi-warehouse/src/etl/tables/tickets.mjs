// ============================================================================
// Syncs TicketingDB.dbo.Tk_TicketInfoMaster into fact_ticket.
//
// Columns confirmed against real INFORMATION_SCHEMA.COLUMNS output (not
// guessed) — corrections from the original placeholder draft:
//   - No DeptID column exists. GroupID is the real department/group grouping
//     column on this table and is used instead.
//   - No plain EntryDate/UpdateDate pair exists. The real columns are
//     DateAdded (row creation) and DateUpdated (row revision) — used for
//     opened_date and the incremental watermark respectively. Note there is
//     also a separately-listed UpdatedDate column in the schema, which
//     appears to be a redundant/duplicate legacy column; DateUpdated is used
//     as the authoritative one since it pairs naturally with DateAdded.
//   - No ResolvedDate column exists on this table. StatusChangeDate is the
//     closest candidate but has NOT been independently confirmed to mean
//     "date the ticket was resolved" (it could reflect any status change,
//     not specifically resolution) — per the project's "no assumptions"
//     rule, this is treated as an unconfirmed approximation, not asserted
//     as fact. It is NOT mapped here; resolved_date is left null until this
//     is verified against real data (e.g. checking StatusChangeDate values
//     against TicketStatusID = closed/resolved).
//   - No StatusName column exists on this table itself — TicketStatusID is
//     a numeric FK, stored as-is rather than resolved to a name here.
// ============================================================================

import sql from 'mssql';
import { getSourcePool } from '../../config/db.mjs';
import { upsertRows } from '../lib/upsert.mjs';
import { getLastSyncedAt, recordSyncStart, recordSyncSuccess, recordSyncFailure } from '../lib/syncLog.mjs';

const SOURCE_TABLE_NAME = 'Tk_TicketInfoMaster';

export async function syncTickets() {
  await recordSyncStart(SOURCE_TABLE_NAME);
  try {
    const lastSyncedAt = await getLastSyncedAt(SOURCE_TABLE_NAME);
    const pool = await getSourcePool('TicketingDB');

    const request = pool.request();
    let whereClause = '';
    if (lastSyncedAt) {
      request.input('since', sql.DateTime, lastSyncedAt);
      whereClause = `WHERE DateAdded > @since OR DateUpdated > @since`;
    }

    const result = await request.query(`
      SELECT SNID, CustomerID, TicketTypeID, GroupID,
             DateAdded, DateUpdated, TicketStatusID
      FROM dbo.${SOURCE_TABLE_NAME}
      ${whereClause}
    `);

    const rows = result.recordset;
    if (!rows.length) {
      await recordSyncSuccess(SOURCE_TABLE_NAME, { rowCount: 0, newWatermark: lastSyncedAt || new Date() });
      return { table: SOURCE_TABLE_NAME, rowCount: 0 };
    }

    const mapped = rows.map((row) => ({
      source_ticket_id: row.SNID,
      customer_id: row.CustomerID,
      department_id: row.GroupID,
      ticket_type_id: row.TicketTypeID,
      opened_date: row.DateAdded,
      resolved_date: null, // no confirmed resolved-date column on this table yet — see header comment
      status: row.TicketStatusID,
    }));

    const written = await upsertRows('fact_ticket', ['source_ticket_id'], mapped);

    const newWatermark = rows.reduce((max, row) => {
      const candidate = row.DateUpdated && row.DateUpdated > row.DateAdded ? row.DateUpdated : row.DateAdded;
      return candidate > max ? candidate : max;
    }, lastSyncedAt || new Date(0));

    await recordSyncSuccess(SOURCE_TABLE_NAME, { rowCount: written, newWatermark });
    return { table: SOURCE_TABLE_NAME, rowCount: written };
  } catch (error) {
    await recordSyncFailure(SOURCE_TABLE_NAME, error);
    throw error;
  }
}
