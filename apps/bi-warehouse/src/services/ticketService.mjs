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

/**
 * FIX 2026-10-01: this used to return bare numeric ticket_type_id values
 * with no name attached when groupBy === 'ticket_type_id' -- the chat
 * then had no choice but to show "Type 7" instead of the real name, even
 * though dim_ticket_type IS synced (see getTicketTypeBreakdown, which
 * already did this correctly). Reusing the same small name-lookup here so
 * EVERY path through this tool shows real names, not just the dedicated
 * breakdown tool.
 */
export async function getTicketMetrics({ dateFrom, dateTo, groupBy } = {}) {
  const [volume, avgResolution] = await Promise.all([
    queryTicketMetric('ticket_volume', { dateFrom, dateTo, groupBy }),
    queryTicketMetric('avg_resolution_hours', { dateFrom, dateTo, groupBy }),
  ]);

  if (groupBy === 'ticket_type_id') {
    const nameById = await getTicketTypeNameMap();
    const attachName = (rows) =>
      rows.map((r) => ({ ...r, ticket_type_name: nameById.get(String(r.ticket_type_id)) ?? null }));
    return { volume: attachName(volume), avgResolutionHours: attachName(avgResolution) };
  }

  return { volume, avgResolutionHours: avgResolution };
}

/** Shared by getTicketMetrics and getTicketTypeBreakdown -- one real query, not two copies of the same SQL. */
async function getTicketTypeNameMap() {
  const pool = getWarehousePool();
  const { rows } = await pool.query('SELECT ticket_type_id, ticket_type_name FROM dim_ticket_type');
  return new Map(rows.map((r) => [String(r.ticket_type_id), r.ticket_type_name]));
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
  // REFACTOR 2026-10-01: now shares getTicketTypeNameMap() with
  // getTicketMetrics instead of its own copy of this exact query.
  const nameById = await getTicketTypeNameMap();

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

/**
 * NEW 2026-10-01: every tool above this point was aggregate-only (a count,
 * an average, a breakdown) -- there was no way to actually see the
 * individual tickets behind a number. Asking "show me each ticket of type
 * X" had nothing to call but the breakdown tools, which can only ever
 * answer with a total. This returns real, individual fact_ticket rows,
 * filtered by any combination of type/department/status/date range, with
 * the real ticket_type_name joined in (same LEFT JOIN as everywhere else
 * here -- a row whose type predates the dimension sync still shows up,
 * with an honest null name rather than being dropped). department_id is
 * deliberately NOT resolved to a name -- see etl/tables/referenceTables.mjs's
 * own comment: the GroupID -> DeptID mapping is still unverified, so this
 * reports the raw id rather than guessing a name that could be wrong.
 * resolved_date will be null on every row -- no confirmed resolved-date
 * column exists in the real source system yet (see tickets.mjs header).
 */
export async function getTicketList({
  ticketTypeId,
  departmentId,
  status,
  dateFrom,
  dateTo,
  limit = 200,
  offset = 0,
  withSummary = true,
} = {}) {
  const pool = getWarehousePool();
  const conditions = [];
  const params = [];

  // FIX 2026-10-01, PERFORMANCE REWRITE same day: the id-or-name match
  // below used to be `(f.ticket_type_id = $1 OR dtt.ticket_type_name
  // ILIKE $2)` directly against fact_ticket -- correct, but ILIKE against
  // a joined text column can't use an index, so this condition forced a
  // scan of the full fact_ticket table (now up to 5,000 rows RETURNED,
  // but the WHERE clause still has to examine every row to find them) --
  // and then the totalCount query below paid that SAME expensive cost a
  // second time, in parallel. Real, measured result: "all information for
  // every ticket under fiber type tickets" timed out at 150s
  // (readonly-api.mjs's own request timeout) instead of returning.
  // Fix: resolve ticketTypeId (id OR name) against dim_ticket_type FIRST
  // -- a tiny lookup table, a few dozen rows -- then filter fact_ticket by
  // the resolved raw id with a plain equality check, which can use an
  // index and never needs ILIKE or a join condition on the big table at
  // all. If the name/id doesn't resolve to anything real, fall back to
  // matching the raw value as given (an honest "no matching ticket type"
  // result, same as before -- never silently drops the filter).
  let resolvedTicketTypeId = ticketTypeId;
  if (ticketTypeId) {
    const lookup = await pool.query(
      `SELECT ticket_type_id FROM dim_ticket_type WHERE ticket_type_id = $1 OR ticket_type_name ILIKE $1 LIMIT 1`,
      [ticketTypeId],
    );
    resolvedTicketTypeId = lookup.rows[0]?.ticket_type_id ?? ticketTypeId;
  }
  if (resolvedTicketTypeId) {
    params.push(resolvedTicketTypeId);
    conditions.push(`f.ticket_type_id = $${params.length}`);
  }
  if (departmentId) {
    params.push(departmentId);
    conditions.push(`f.department_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`f.status = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`f.opened_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`f.opened_date <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // FIX 2026-10-01: real bug found live -- "ticket report for fiber issue
  // ticket full" silently returned only 200 rows (the default) with
  // nothing telling the user there were 41,500+ real rows behind it. Two
  // separate problems:
  //   1. The caller passes `limit: undefined` for an explicit "full"
  //      request (see agent.mjs's fastPathArgs.limit description -- the
  //      model is told to send null/omit limit for "the full unranked
  //      list"), which fell straight into the `|| 200` default -- there
  //      was never a way to actually ask for more than 200 rows.
  //   2. Even a raised limit had a silent ceiling (2000) with no signal
  //      anywhere that the result was cut short.
  // Fix: raise the hard ceiling to MAX_ROWS (matches the Query Governor
  // cap already documented for this system -- 5,000 rows/request), make
  // an explicit "full" request (no limit passed) use that ceiling instead
  // of 200, and return the REAL total row count alongside the capped rows
  // so callers (the chat narrative, the table header) can say "showing
  // 5,000 of 41,500" instead of silently presenting a partial result as
  // if it were everything.
  const MAX_ROWS = 5000;
  const effectiveLimit = Math.max(1, Math.min(Number(limit) || MAX_ROWS, MAX_ROWS));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const queryParams = [...params, safeOffset, effectiveLimit];

  const [{ rows }, countResult] = await Promise.all([
    pool.query(
      `
        SELECT
          f.ticket_sk, f.source_ticket_id, f.customer_id, f.department_id,
          f.ticket_type_id, dtt.ticket_type_name, f.opened_date,
          f.resolved_date, f.status
        FROM fact_ticket f
        LEFT JOIN dim_ticket_type dtt ON f.ticket_type_id = dtt.ticket_type_id
        ${whereClause}
        ORDER BY f.opened_date DESC
        OFFSET $${queryParams.length - 1} LIMIT $${queryParams.length}
      `,
      queryParams,
    ),
    pool.query(
      `
        SELECT count(*)::int AS total
        FROM fact_ticket f
        LEFT JOIN dim_ticket_type dtt ON f.ticket_type_id = dtt.ticket_type_id
        ${whereClause}
      `,
      params,
    ),
  ]);

  // NEW 2026-10-04: summary computed in SQL over the FULL filtered set
  // (not the capped rows), so the chat reply can describe all tickets --
  // status split, top types, date span -- instead of narrating a sample.
  const [statusRes, typeRes, spanRes] = withSummary ? await Promise.all([
    pool.query(
      `SELECT COALESCE(f.status::text, 'Unknown') AS status, count(*)::int AS count
       FROM fact_ticket f ${whereClause}
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      params,
    ),
    pool.query(
      `SELECT COALESCE(dtt.ticket_type_name, 'Type ' || f.ticket_type_id::text, 'Unknown') AS type, count(*)::int AS count
       FROM fact_ticket f
       LEFT JOIN dim_ticket_type dtt ON f.ticket_type_id = dtt.ticket_type_id
       ${whereClause}
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      params,
    ),
    pool.query(
      `SELECT min(f.opened_date) AS first_opened, max(f.opened_date) AS last_opened
       FROM fact_ticket f ${whereClause}`,
      params,
    ),
  ]) : [{ rows: [] }, { rows: [] }, { rows: [] }];

  return {
    rows,
    totalCount: countResult.rows[0]?.total ?? rows.length,
    summary: {
      byStatus: statusRes.rows,
      topTypes: typeRes.rows,
      firstOpened: spanRes.rows[0]?.first_opened ?? null,
      lastOpened: spanRes.rows[0]?.last_opened ?? null,
    },
  };
}

/**
 * NEW 2026-10-03: there was no way to actually get every ticket as a
 * file -- getTicketList is correctly capped at 5,000 (the project's own
 * documented Query Governor cap, for on-screen/AI use), and the chat
 * panel's "Export Excel" only ever builds its file from whatever's
 * ALREADY loaded in the browser (so it inherited that same 5,000 cap too
 * -- a real gap, not by design). This is the real, unbounded path: a
 * genuine server-side Postgres CURSOR (same technique as
 * revenueService.streamAllCustomerFinancials) that streams rows in
 * batches straight to the caller, so memory here stays flat whether
 * there are 5,000 tickets or 5,000,000 -- never holds the whole result
 * set in memory at once the way getTicketList's array return does.
 * Mirrors getTicketList's own filter/resolve-first logic for
 * ticketTypeId (see that function's own comment for why -- resolve
 * against the small dim_ticket_type table first, never ILIKE/join
 * against fact_ticket directly) so the two stay consistent, but is
 * otherwise a separate code path by design (see
 * app/api/exports/customers/route.ts's own comment on why a true
 * full-dataset export is deliberately its own route, not a flag on the
 * existing bounded export).
 */
export async function streamAllTickets({ ticketTypeId, departmentId, status, dateFrom, dateTo, batchSize = 5000 } = {}, onBatch) {
  const pool = getWarehousePool();

  let resolvedTicketTypeId = ticketTypeId;
  if (ticketTypeId) {
    const lookup = await pool.query(
      `SELECT ticket_type_id FROM dim_ticket_type WHERE ticket_type_id = $1 OR ticket_type_name ILIKE $1 LIMIT 1`,
      [ticketTypeId],
    );
    resolvedTicketTypeId = lookup.rows[0]?.ticket_type_id ?? ticketTypeId;
  }

  const conditions = [];
  const params = [];
  if (resolvedTicketTypeId) {
    params.push(resolvedTicketTypeId);
    conditions.push(`f.ticket_type_id = $${params.length}`);
  }
  if (departmentId) {
    params.push(departmentId);
    conditions.push(`f.department_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`f.status = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`f.opened_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`f.opened_date <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
      DECLARE all_tickets CURSOR FOR
      SELECT
        f.ticket_sk, f.source_ticket_id, f.customer_id, f.department_id,
        f.ticket_type_id, dtt.ticket_type_name, f.opened_date,
        f.resolved_date, f.status
      FROM fact_ticket f
      LEFT JOIN dim_ticket_type dtt ON f.ticket_type_id = dtt.ticket_type_id
      ${whereClause}
      ORDER BY f.opened_date DESC
      `,
      params,
    );

    let totalRows = 0;
    for (;;) {
      const { rows } = await client.query(`FETCH ${batchSize} FROM all_tickets`);
      if (!rows.length) break;
      totalRows += rows.length;
      await onBatch(rows);
      if (rows.length < batchSize) break;
    }
    await client.query('CLOSE all_tickets');
    await client.query('COMMIT');
    return { totalRows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
