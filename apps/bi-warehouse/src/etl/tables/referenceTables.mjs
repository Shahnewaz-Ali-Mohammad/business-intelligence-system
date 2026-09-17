// ============================================================================
// Syncs small, rarely-changing reference/dimension tables: POPMaster,
// PackageMaster, StatusMaster, Division/District (-> dim_region).
//
// These are all small (hundreds to low thousands of rows), so — per the
// decided per-table sync strategy — they get a full truncate-and-reload
// every run instead of incremental logic. Simpler, and cheap at this size.
// ============================================================================

import { getSourcePool } from '../../config/db.mjs';
import { getWarehousePool } from '../../config/db.mjs';
import { recordSyncStart, recordSyncSuccess, recordSyncFailure } from '../lib/syncLog.mjs';

async function fullReload(warehouseTable, sourceSql, mapRow, sourceTableLabel, sourceDb = 'billGENIXDB') {
  await recordSyncStart(sourceTableLabel);
  try {
    const pool = await getSourcePool(sourceDb);
    const result = await pool.request().query(sourceSql);
    const rows = result.recordset.map(mapRow);

    const wh = getWarehousePool();
    const client = await wh.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE TABLE ${warehouseTable} CASCADE`);
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${warehouseTable} (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await recordSyncSuccess(sourceTableLabel, { rowCount: rows.length, newWatermark: new Date() });
    return { table: sourceTableLabel, rowCount: rows.length };
  } catch (error) {
    await recordSyncFailure(sourceTableLabel, error);
    throw error;
  }
}

export async function syncPopMaster() {
  return fullReload(
    'dim_pop',
    `SELECT POPID, POPName FROM dbo.POPMaster`,
    (row) => ({ pop_id: row.POPID, pop_name: row.POPName }),
    'POPMaster'
  );
}

export async function syncPackageMaster() {
  // Column names confirmed against real INFORMATION_SCHEMA.COLUMNS output —
  // PackageMaster has NO PackageName or Price column. Closest real
  // substitutes: BandwidthName (a human-readable package label) for
  // package_name, and LastPackageMRC (the package's monthly recurring
  // charge) for price.
  return fullReload(
    'dim_package',
    `SELECT BID, BandwidthName, Bandwidth, LastPackageMRC FROM dbo.PackageMaster`,
    (row) => ({
      package_id: row.BID,
      package_name: row.BandwidthName,
      bandwidth: row.Bandwidth,
      price: row.LastPackageMRC,
    }),
    'PackageMaster'
  );
}

export async function syncStatusMaster() {
  return fullReload(
    'dim_status',
    `SELECT StatusID, StatusName FROM dbo.StatusMaster`,
    (row) => ({ status_id: row.StatusID, status_name: row.StatusName }),
    'StatusMaster'
  );
}

// FIX 2026-09-15: dim_ticket_type existed in warehouse-schema.sql from the
// start but was never populated -- the schema's own PATCH comment says no
// TicketingDB source table for it was confirmed at the time, so fact_ticket's
// FK to it was dropped and ticket_type_id was left as a raw, unresolved
// number everywhere (chat, chart, table). A real schema dump since then
// (INFORMATION_SCHEMA.COLUMNS against the actual TicketingDB) DID find a
// real Tk_TicketType table with TicketTypeID/TicketTypeName columns -- see
// tickets.mjs's own header, which maps fact_ticket.ticket_type_id directly
// from Tk_TicketInfoMaster.TicketTypeID, the same TicketingDB. That's a
// direct, same-database FK relationship (not a cross-database guess), so
// this is safe to sync and join, unlike department (see note below).
export async function syncTicketType() {
  return fullReload(
    'dim_ticket_type',
    `SELECT TicketTypeID, TicketTypeName FROM dbo.Tk_TicketType`,
    (row) => ({ ticket_type_id: row.TicketTypeID, ticket_type_name: row.TicketTypeName }),
    'Tk_TicketType',
    'TicketingDB',
  );
}

// NOT wired into sync.mjs and deliberately NOT joined anywhere yet.
// Tk_Department (DeptID/DeptName) is real and confirmed to exist in
// TicketingDB, but fact_ticket.department_id is populated from
// Tk_TicketInfoMaster.GroupID (see tickets.mjs's header -- there is no
// DeptID column on that table, GroupID was substituted because it looked
// like the closest real department/group column). Whether GroupID and
// Tk_Department.DeptID are actually the same ID space has NOT been
// confirmed against real data -- per this project's "no assumptions" rule,
// joining dim_department onto fact_ticket.department_id right now would
// silently attach department NAMES to what might be the wrong IDs, which
// is worse than showing the honest raw number. Left here, unused, until
// that mapping is verified (e.g. checking that GroupID values in
// fact_ticket actually appear as DeptID values in Tk_Department).
export async function syncDepartment() {
  return fullReload(
    'dim_department',
    `SELECT DeptID, DeptName FROM dbo.Tk_Department`,
    (row) => ({ department_id: row.DeptID, department_name: row.DeptName }),
    'Tk_Department',
    'TicketingDB',
  );
}

export async function syncRegion() {
  // Combines Division + District into one flattened dim_region row per
  // district. Adjust the join once the exact FK column between District
  // and Division is confirmed (inferred as DivisionId here — no enforced
  // FK exists in this schema, per the earlier constraints finding).
  return fullReload(
    'dim_region',
    `
      SELECT d.DistrictId AS RegionId, di.DivisionName, d.DistrictName, NULL AS CityCorporation
      FROM dbo.District d
      LEFT JOIN dbo.Division di ON d.DivisionId = di.DivisionId
    `,
    (row) => ({
      region_id: row.RegionId,
      division_name: row.DivisionName,
      district_name: row.DistrictName,
      city_corporation: row.CityCorporation,
    }),
    'Division_District'
  );
}
