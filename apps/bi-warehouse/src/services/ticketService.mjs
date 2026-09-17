// ============================================================================
// BI service functions for ticket metrics. Same rule as revenueService.js:
// this is the ONLY place ticket SQL gets written — dashboard/chat/reports
// all call these functions, never fact_ticket directly.
// ============================================================================

import { getWarehousePool } from '../config/db.mjs';
import { getMetric, assertValidDimension, JOIN_DIMENSIONS } from '../semantic/metrics.mjs';

async function queryTicketMetric(metricName, { groupBy, dateFrom, dateTo } = {}) {
  assertValidDimension(metricName, groupBy);
  const metric = getMetric(metricName);
  const pool = getWarehousePool();

  const conditions = [];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`f.opened_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`f.opened_date <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // FIX 2026-09-17: fact_ticket has no direct pop_id column -- resolving it
  // needs the same JOIN_DIMENSIONS pattern revenueService.mjs's
  // queryMetric already uses (join to dim_customer via the real, direct
  // customer_id column fact_ticket DOES have -- confirmed against
  // warehouse-schema.sql). department_id/ticket_type_id/opened_date/
  // customer_id are all real direct columns on fact_ticket itself, so they
  // still take the plain (no-join) path. appliesToTables gate matches the
  // same fix in revenueService.mjs's queryMetric -- only join when
  // fact_ticket is actually listed as lacking the column directly.
  const joinDef = groupBy ? JOIN_DIMENSIONS[groupBy] : null;
  const join = joinDef && joinDef.appliesToTables.includes(metric.table) ? joinDef : null;

  let query;
  if (join) {
    query = `
      SELECT ${join.alias}.${join.column} AS ${groupBy}, ${metric.sql} AS value
      FROM ${metric.table} f
      LEFT JOIN ${join.table} ${join.alias} ON f.${join.on} = ${join.alias}.${join.on}
      ${whereClause}
      GROUP BY ${join.alias}.${join.column}
    `;
  } else {
    const selectGroupBy = groupBy ? `f.${groupBy}, ` : '';
    const groupByClause = groupBy ? `GROUP BY f.${groupBy}` : '';
    query = `
      SELECT ${selectGroupBy}${metric.sql} AS value
      FROM ${metric.table} f
      ${whereClause}
      ${groupByClause}
    `;
  }
  const { rows } = await pool.query(query, params);
  return rows;
}

/** get_status_breakdown / ticket volume MCP tool backs onto this. */
export async function getTicketMetrics({ dateFrom, dateTo, groupBy } = {}) {
  const [volume, avgResolution] = await Promise.all([
    queryTicketMetric('ticket_volume', { dateFrom, dateTo, groupBy }),
    queryTicketMetric('avg_resolution_hours', { dateFrom, dateTo, groupBy }),
  ]);
  return { volume, avgResolutionHours: avgResolution };
}

// FIX 2026-09-15: dashboardData() (apps/bi-dashboard) never fetched a
// ticket-type breakdown at all -- it only ever called getTicketMetrics({})
// with no groupBy, so there was no real per-type data for the chat/report
// UI to chart, and the chart picker had no branch for the "tickets" topic
// either (both fixed alongside this). This is the real, always-available
// breakdown by ticket_type_id -- see semantic/metrics.mjs, ticket_volume's
// validDimensions includes ticket_type_id, and it's a real populated
// column (TicketTypeID from Tk_TicketInfoMaster, confirmed in the ETL --
// see etl/tables/tickets.mjs). There is NO dim_ticket_type name lookup
// synced into the warehouse yet (Tk_TicketType exists in the real
// TicketingDB but has not been ETL'd), so this returns numeric type IDs,
// not names -- callers must be honest about that, not invent names.
// MULTI-METRIC 2026-09-17: added avgResolutionHours alongside count --
// ticket_volume AND avg_resolution_hours both list ticket_type_id as a
// valid dimension (see metrics.mjs), so a genuine two-metric breakdown by
// type is real, not invented. avg_resolution_hours will come back null for
// every row right now (no confirmed "ticket resolved" column exists in the
// source system yet -- see metrics.mjs's own comment on that metric), and
// this returns that null honestly rather than hiding the column or
// pretending the metric doesn't exist -- the moment a real resolved-date
// column is confirmed and wired into the ETL, this starts returning real
// numbers with no further changes needed here.
// `limit`/`sortBy`/`direction` mirror getPopFinancials' contract exactly --
// set by the caller (the LLM's own structured tool call), never guessed
// from the user's raw text with a regex. sortBy accepts 'count' (default)
// or 'avgResolutionHours'; the latter is real for consistency even though
// every value is null today.
/**
 * NEW 2026-09-17: real ticket COUNT and avg resolution time TOGETHER, one
 * row per POP -- fills the "tickets by POP" gap. pop_id resolves via the
 * same JOIN_DIMENSIONS pattern as everywhere else (fact_ticket.customer_id
 * -> dim_customer.pop_id). avgResolutionHours will be null for every row
 * for the same reason it is everywhere else (see avg_resolution_hours'
 * own comment in metrics.mjs) -- shown honestly, not hidden.
 * `limit`/`sortBy`/`direction` mirror getTicketTypeBreakdown's contract.
 */
export async function getTicketPopBreakdown({ dateFrom, dateTo, limit, sortBy = 'count', direction = 'desc' } = {}) {
  const [volumeRows, resolutionRows] = await Promise.all([
    queryTicketMetric('ticket_volume', { dateFrom, dateTo, groupBy: 'pop_id' }),
    queryTicketMetric('avg_resolution_hours', { dateFrom, dateTo, groupBy: 'pop_id' }),
  ]);

  const resolutionByPop = new Map(
    resolutionRows.map((r) => [r.pop_id ?? 'Unassigned', r.value === null ? null : Number(r.value)]),
  );

  let rows = volumeRows.map((row) => ({
    pop: row.pop_id ?? 'Unassigned',
    count: Number(row.value ?? 0),
    avgResolutionHours: resolutionByPop.get(row.pop_id ?? 'Unassigned') ?? null,
  }));

  const sortKey = sortBy === 'avgResolutionHours' ? 'avgResolutionHours' : 'count';
  const sign = direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)));

  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

export async function getTicketTypeBreakdown({ dateFrom, dateTo, limit, sortBy = 'count', direction = 'desc' } = {}) {
  const [volumeRows, resolutionRows] = await Promise.all([
    queryTicketMetric('ticket_volume', { dateFrom, dateTo, groupBy: 'ticket_type_id' }),
    queryTicketMetric('avg_resolution_hours', { dateFrom, dateTo, groupBy: 'ticket_type_id' }),
  ]);

  // UPDATE 2026-09-15: dim_ticket_type is now actually synced (see
  // referenceTables.mjs's syncTicketType, wired into etl/sync.mjs) from the
  // real Tk_TicketType table -- so real names can be attached here via a
  // plain LEFT JOIN, instead of returning bare numeric IDs. LEFT JOIN (not
  // INNER) so a ticket_type_id that predates the dimension sync, or has no
  // matching row, still shows up with its real count and an honest null
  // name rather than silently disappearing from the breakdown.
  const pool = getWarehousePool();
  const { rows: nameRows } = await pool.query('SELECT ticket_type_id, ticket_type_name FROM dim_ticket_type');
  const nameById = new Map(nameRows.map((r) => [String(r.ticket_type_id), r.ticket_type_name]));

  const resolutionByType = new Map(
    resolutionRows.map((r) => [String(r.ticket_type_id), r.value === null ? null : Number(r.value)]),
  );

  let rows = volumeRows.map((row) => ({
    ticketTypeId: row.ticket_type_id,
    ticketTypeName: nameById.get(String(row.ticket_type_id)) ?? null,
    count: Number(row.value ?? 0),
    avgResolutionHours: resolutionByType.get(String(row.ticket_type_id)) ?? null,
  }));

  const sortKey = sortBy === 'avgResolutionHours' ? 'avgResolutionHours' : 'count';
  const sign = direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)));

  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}
