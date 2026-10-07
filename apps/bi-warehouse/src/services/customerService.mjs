// ============================================================================
// Customer roster / lifecycle queries -- entry date, activation date,
// status, POP, package. Kept separate from revenueService.mjs because
// these questions are about WHO the customers are and WHEN they joined,
// not about billed/collected amounts; queryMetric() in revenueService.mjs
// hardcodes its date filter to `f.ref_date` on a fact table, which
// dim_customer (the real source of entry_date/activated_date) doesn't
// have at all -- that mismatch is exactly why "customers entry date from
// 2022 to 2024" had no tool to answer it before this file existed.
// ============================================================================

import { getWarehousePool } from '../config/db.mjs';

const DATE_FIELD_COLUMN = {
  entry: 'entry_date',
  activated: 'activated_date',
};

function buildDateCondition(params, column, dateFrom, dateTo) {
  const conditions = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`${column} >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`${column} <= $${params.length}`);
  }
  return conditions;
}

// FIX 2026-10-01: popId/packageId/statusId below used to match ONLY the
// raw id column -- the exact same bug class just found live in
// ticketService.getTicketList (asking for a ticket type by its real NAME
// matched nothing, because the filter only ever compared against the raw
// code). dim_pop.pop_name, dim_package.package_name, and
// dim_status.status_name are all real, synced columns a user would
// naturally say ("customers in Mirpur", "customers on the Gold package",
// "active customers") -- this was never actually exercised yet, but it is
// the identical vulnerability, found by auditing every other id-filter in
// this codebase for the same pattern rather than waiting for it to fail
// live too. Each of these now matches EITHER the raw id OR the real name
// (case-insensitive), via a LEFT JOIN to the relevant dimension table.
// FIX 2026-10-01, PERFORMANCE REWRITE same day: real, measured timeout
// found live -- the SAME root cause just fixed in ticketService
// .getTicketList's own comment applies here too. buildIdOrNameCondition's
// ILIKE-on-a-joined-column can't use an index, forcing a scan of
// dim_customer (this system's largest dimension table, real production
// scale) every time a POP/package/status is given by name -- doubled by
// getCustomerList's own totalCount query paying the identical cost a
// second time in parallel. Resolving against the small reference table
// FIRST (dim_pop/dim_package/dim_status -- at most a few hundred rows)
// and then filtering dim_customer by the resolved raw id with a plain,
// indexable equality check avoids ILIKE on the big table entirely. Falls
// back to matching the given value as-is if nothing resolves -- an
// honest "no match" result, never a silently dropped filter.
async function resolveIdOrName(pool, { table, idColumn, nameColumn }, value) {
  const { rows } = await pool.query(
    `SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} = $1 OR ${nameColumn} ILIKE $1 LIMIT 1`,
    [value],
  );
  return rows[0]?.id ?? value;
}

/**
 * Count of customers whose entry_date (signup) or activated_date falls
 * within [dateFrom, dateTo], optionally broken down by month, POP, or
 * package. Backs get_customer_signups.
 */
export async function getCustomerSignups({
  dateField = 'entry',
  dateFrom,
  dateTo,
  groupBy, // undefined | 'month' | 'pop_id' | 'package_id' | 'status_id'
  popId,
  packageId,
  statusId,
} = {}) {
  const column = `dc.${DATE_FIELD_COLUMN[dateField] ?? DATE_FIELD_COLUMN.entry}`;
  const pool = getWarehousePool();
  const params = [];
  const conditions = buildDateCondition(params, column, dateFrom, dateTo);

  // entry_date/activated_date can be NULL (customer never activated, or
  // was migrated without a recorded entry date) -- always exclude NULLs
  // from a date-ranged count rather than letting them silently pass an
  // open-ended range, which would overcount "all time" as if it matched
  // any specific range given.
  conditions.push(`${column} IS NOT NULL`);

  // dc = dim_customer, aliased because id-or-name matching below needs
  // LEFT JOINs to dim_pop/dim_package/dim_status for the real names (see
  // buildIdOrNameCondition's own comment) -- every column reference above
  // and below is qualified with dc./dp./dpk./ds. so none of them collide
  // with the joined tables' own id/name columns.
  const resolvedPopId = popId ? await resolveIdOrName(pool, { table: 'dim_pop', idColumn: 'pop_id', nameColumn: 'pop_name' }, popId) : undefined;
  const resolvedPackageId = packageId ? await resolveIdOrName(pool, { table: 'dim_package', idColumn: 'package_id', nameColumn: 'package_name' }, packageId) : undefined;
  const resolvedStatusId = statusId ? await resolveIdOrName(pool, { table: 'dim_status', idColumn: 'status_id', nameColumn: 'status_name' }, statusId) : undefined;
  if (resolvedPopId) { params.push(resolvedPopId); conditions.push(`dc.pop_id = $${params.length}`); }
  if (resolvedPackageId) { params.push(resolvedPackageId); conditions.push(`dc.package_id = $${params.length}`); }
  if (resolvedStatusId) { params.push(resolvedStatusId); conditions.push(`dc.status_id = $${params.length}`); }

  const joins = `
       LEFT JOIN dim_pop dp ON dc.pop_id = dp.pop_id
       LEFT JOIN dim_package dpk ON dc.package_id = dpk.package_id
       LEFT JOIN dim_status ds ON dc.status_id = ds.status_id`;
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  if (groupBy === 'month') {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month', ${column}), 'YYYY-MM') AS period,
              COUNT(DISTINCT dc.customer_id) AS count
       FROM dim_customer dc
       ${joins}
       ${whereClause}
       GROUP BY 1
       ORDER BY 1`,
      params,
    );
    return { groupBy: 'month', rows: rows.map((r) => ({ period: r.period, count: Number(r.count) })) };
  }

  if (groupBy === 'pop_id' || groupBy === 'package_id' || groupBy === 'status_id') {
    const { rows } = await pool.query(
      `SELECT dc.${groupBy}, COUNT(DISTINCT dc.customer_id) AS count
       FROM dim_customer dc
       ${joins}
       ${whereClause}
       GROUP BY dc.${groupBy}
       ORDER BY count DESC`,
      params,
    );
    return { groupBy, rows: rows.map((r) => ({ [groupBy]: r[groupBy], count: Number(r.count) })) };
  }

  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT dc.customer_id) AS count FROM dim_customer dc ${joins} ${whereClause}`,
    params,
  );
  return { groupBy: null, count: Number(rows[0]?.count || 0) };
}

/**
 * Row-level customer list for a date range -- name/id/pop/package/status
 * plus the entry/activation dates themselves, capped like every other
 * ranked tool (see MAX_RANKED_LIMIT in src/mcp/server.mjs). Backs
 * get_customer_list.
 */
export async function getCustomerList({
  dateField = 'entry',
  dateFrom,
  dateTo,
  popId,
  packageId,
  statusId,
  limit = 100,
  offset = 0,
  withSummary = true,
} = {}) {
  const column = `dc.${DATE_FIELD_COLUMN[dateField] ?? DATE_FIELD_COLUMN.entry}`;
  const pool = getWarehousePool();
  const params = [];
  const conditions = buildDateCondition(params, column, dateFrom, dateTo);
  conditions.push(`${column} IS NOT NULL`);

  // Same id-or-name matching as getCustomerSignups above -- see
  // resolveIdOrName's own comment for why this resolves against the
  // small dimension table first instead of filtering dim_customer with
  // an ILIKE join condition directly.
  const resolvedPopId = popId ? await resolveIdOrName(pool, { table: 'dim_pop', idColumn: 'pop_id', nameColumn: 'pop_name' }, popId) : undefined;
  const resolvedPackageId = packageId ? await resolveIdOrName(pool, { table: 'dim_package', idColumn: 'package_id', nameColumn: 'package_name' }, packageId) : undefined;
  const resolvedStatusId = statusId ? await resolveIdOrName(pool, { table: 'dim_status', idColumn: 'status_id', nameColumn: 'status_name' }, statusId) : undefined;
  if (resolvedPopId) { params.push(resolvedPopId); conditions.push(`dc.pop_id = $${params.length}`); }
  if (resolvedPackageId) { params.push(resolvedPackageId); conditions.push(`dc.package_id = $${params.length}`); }
  if (resolvedStatusId) { params.push(resolvedStatusId); conditions.push(`dc.status_id = $${params.length}`); }

  // FIX 2026-10-01: same bug class as ticketService.getTicketList (see its
  // own comment) found during a proactive audit after the ticket_list
  // version was caught live -- "full" collapsed to the 100-row default
  // with NOTHING telling the caller there was more data, and worse, there
  // was no upper ceiling at all (an explicit huge limit would run
  // unbounded, violating this project's own documented Query Governor cap
  // of ~5,000 rows/request). Same fix: a real ceiling (MAX_ROWS), an
  // explicit "full" request (no limit) uses that ceiling instead of 100,
  // and the real total row count is returned alongside the capped rows so
  // the chat/table can say "showing 5,000 of N" instead of presenting a
  // partial result as if it were everything.
  const MAX_ROWS = 5000;
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) && limit > 0 ? limit : MAX_ROWS, MAX_ROWS));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const queryParams = [...params, safeOffset, safeLimit];

  const [{ rows }, countResult] = await Promise.all([
    pool.query(
      `SELECT dc.customer_id, dc.customer_name, dc.pop_id, dp.pop_name, dc.package_id, dpk.package_name,
              dc.status_id, ds.status_name, dc.entry_date, dc.activated_date
       FROM dim_customer dc
       LEFT JOIN dim_pop dp ON dc.pop_id = dp.pop_id
       LEFT JOIN dim_package dpk ON dc.package_id = dpk.package_id
       LEFT JOIN dim_status ds ON dc.status_id = ds.status_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${column} DESC
       OFFSET $${queryParams.length - 1} LIMIT $${queryParams.length}`,
      queryParams,
    ),
    pool.query(
      `SELECT count(*)::int AS total
       FROM dim_customer dc
       LEFT JOIN dim_pop dp ON dc.pop_id = dp.pop_id
       LEFT JOIN dim_package dpk ON dc.package_id = dpk.package_id
       LEFT JOIN dim_status ds ON dc.status_id = ds.status_id
       WHERE ${conditions.join(' AND ')}`,
      params,
    ),
  ]);

  // NEW 2026-10-04: DB-computed summary over ALL matching customers -- the
  // AI answers from this, never from individual rows.
  const joins = `FROM dim_customer dc
       LEFT JOIN dim_pop dp ON dc.pop_id = dp.pop_id
       LEFT JOIN dim_package dpk ON dc.package_id = dpk.package_id
       LEFT JOIN dim_status ds ON dc.status_id = ds.status_id
       WHERE ${conditions.join(' AND ')}`;
  const [statusRes, popRes, pkgRes] = withSummary ? await Promise.all([
    pool.query(`SELECT COALESCE(ds.status_name, 'Status ' || dc.status_id::text, 'Unknown') AS status, count(*)::int AS count ${joins} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),
    pool.query(`SELECT COALESCE(dp.pop_name, 'POP ' || dc.pop_id::text, 'Unknown') AS pop, count(*)::int AS count ${joins} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),
    pool.query(`SELECT COALESCE(dpk.package_name, 'Package ' || dc.package_id::text, 'Unknown') AS package, count(*)::int AS count ${joins} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),
  ]) : [{ rows: [] }, { rows: [] }, { rows: [] }];

  return {
    rows,
    totalCount: countResult.rows[0]?.total ?? rows.length,
    summary: { byStatus: statusRes.rows, topPops: popRes.rows, topPackages: pkgRes.rows },
  };
}

/**
 * NEW 2026-10-03: same gap as ticketService.streamAllTickets (see its own
 * comment) -- getCustomerList is correctly capped at 5,000 (the Query
 * Governor cap), and "Export Excel" in chat only ever builds its file
 * from rows already loaded in the browser, so a true "every customer
 * matching X" export never actually existed. Real Postgres CURSOR,
 * mirrors getCustomerList's own filter/resolve-first logic exactly so the
 * two never disagree about which rows match.
 */
export async function streamAllCustomerList({ dateField = 'entry', dateFrom, dateTo, popId, packageId, statusId, batchSize = 5000 } = {}, onBatch) {
  const column = `dc.${DATE_FIELD_COLUMN[dateField] ?? DATE_FIELD_COLUMN.entry}`;
  const pool = getWarehousePool();
  const params = [];
  const conditions = buildDateCondition(params, column, dateFrom, dateTo);
  conditions.push(`${column} IS NOT NULL`);

  const resolvedPopId = popId ? await resolveIdOrName(pool, { table: 'dim_pop', idColumn: 'pop_id', nameColumn: 'pop_name' }, popId) : undefined;
  const resolvedPackageId = packageId ? await resolveIdOrName(pool, { table: 'dim_package', idColumn: 'package_id', nameColumn: 'package_name' }, packageId) : undefined;
  const resolvedStatusId = statusId ? await resolveIdOrName(pool, { table: 'dim_status', idColumn: 'status_id', nameColumn: 'status_name' }, statusId) : undefined;
  if (resolvedPopId) { params.push(resolvedPopId); conditions.push(`dc.pop_id = $${params.length}`); }
  if (resolvedPackageId) { params.push(resolvedPackageId); conditions.push(`dc.package_id = $${params.length}`); }
  if (resolvedStatusId) { params.push(resolvedStatusId); conditions.push(`dc.status_id = $${params.length}`); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
      DECLARE all_customer_list CURSOR FOR
      SELECT dc.customer_id, dc.customer_name, dc.pop_id, dp.pop_name, dc.package_id, dpk.package_name,
             dc.status_id, ds.status_name, dc.entry_date, dc.activated_date
      FROM dim_customer dc
      LEFT JOIN dim_pop dp ON dc.pop_id = dp.pop_id
      LEFT JOIN dim_package dpk ON dc.package_id = dpk.package_id
      LEFT JOIN dim_status ds ON dc.status_id = ds.status_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${column} DESC
      `,
      params,
    );

    let totalRows = 0;
    for (;;) {
      const { rows } = await client.query(`FETCH ${batchSize} FROM all_customer_list`);
      if (!rows.length) break;
      totalRows += rows.length;
      await onBatch(rows);
      if (rows.length < batchSize) break;
    }
    await client.query('CLOSE all_customer_list');
    await client.query('COMMIT');
    return { totalRows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
