// ============================================================================
// BI service functions for billing/collection ("revenue" in the broad
// sense). This is the layer the dashboard, chatbot/MCP tools, and report
// generator ALL call — none of them are allowed to write their own SQL
// against fact_billing/fact_collection directly. That's the whole point of
// this file existing: one implementation, every consumer gets identical
// numbers for the same question.
//
// `filters.region` is accepted but unused for now (RLS is deferred — see
// project doc decision). Keeping the parameter here means wiring real
// row-level security later is a small change, not a rewrite.
// ============================================================================

import { getWarehousePool } from '../config/db.mjs';
import { getMetric, assertValidDimension, JOIN_DIMENSIONS } from '../semantic/metrics.mjs';

async function queryMetric(metricName, { groupBy, dateFrom, dateTo, filters = {} } = {}) {
  assertValidDimension(metricName, groupBy);
  const metric = getMetric(metricName);
  const pool = getWarehousePool();

  const conditions = [];
  const params = [];

  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`f.ref_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`f.ref_date <= $${params.length}`);
  }
  // filters.region intentionally not applied yet — placeholder for future RLS/filtering.

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // A grouping dimension that isn't a real column on the fact table itself
  // needs a join to the dimension table that actually has it, rather than
  // a plain GROUP BY on a column that's always NULL (or, worse, ambiguous
  // against a second copy of the same table) on the fact row. FIX
  // 2026-09-17: only apply the join when THIS metric's table is actually
  // listed in appliesToTables -- see metrics.mjs's own comment on the bug
  // this fixes (a table that already has the column directly, e.g.
  // dim_customer.pop_id or fact_billing/fact_collection.package_id, must
  // use the plain no-join path below, or it self-joins/returns wrong data).
  const joinDef = groupBy ? JOIN_DIMENSIONS[groupBy] : null;
  const join = joinDef && joinDef.appliesToTables.includes(metric.table) ? joinDef : null;

  let query;
  if (join) {
    const selectGroupBy = `${join.alias}.${join.column} AS ${groupBy}, `;
    query = `
      SELECT ${selectGroupBy}${metric.sql.replace(/\bamount\b/g, 'f.amount')} AS value
      FROM ${metric.table} f
      LEFT JOIN ${join.table} ${join.alias} ON f.${join.on} = ${join.alias}.${join.on}
      ${whereClause}
      GROUP BY ${join.alias}.${join.column}
    `;
  } else {
    const selectGroupBy = groupBy ? `f.${groupBy}, ` : '';
    const groupByClause = groupBy ? `GROUP BY f.${groupBy}` : '';
    query = `
      SELECT ${selectGroupBy}${metric.sql.replace(/\bamount\b/g, 'f.amount')} AS value
      FROM ${metric.table} f
      ${whereClause}
      ${groupByClause}
    `;
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/** get_revenue_summary MCP tool backs onto this. */
export async function getRevenueSummary({ dateFrom, dateTo, filters } = {}) {
  // FIX 2026-09-17: total_refunded and total_adjusted were real, defined
  // metrics (metrics.mjs) backed by real, ETL-synced tables (fact_refund,
  // fact_adjustment -- see billingMaster.mjs, both populated from real
  // BillingMaster RefTypeID 5/6 rows) that NOTHING ever actually queried.
  // dashboard-data.mjs's billed/collected/refunded/adjusted chart hardcoded
  // Refunded and Adjusted to a literal 0, labeled as if it were real data.
  // Added here rather than as a separate function -- refunds/adjustments
  // are part of the same "revenue summary" concept as billed/collected.
  const [billedRows, collectedRows, refundedRows, adjustedRows] = await Promise.all([
    queryMetric('total_billed', { dateFrom, dateTo, filters }),
    queryMetric('total_collected', { dateFrom, dateTo, filters }),
    queryMetric('total_refunded', { dateFrom, dateTo, filters }),
    queryMetric('total_adjusted', { dateFrom, dateTo, filters }),
  ]);

  const totalBilled = Number(billedRows[0]?.value || 0);
  const totalCollected = Number(collectedRows[0]?.value || 0);
  const totalRefunded = Number(refundedRows[0]?.value || 0);
  const totalAdjusted = Number(adjustedRows[0]?.value || 0);

  return {
    totalBilled,
    totalCollected,
    totalRefunded,
    totalAdjusted,
    outstandingBalance: totalBilled - totalCollected, // derived, not stored — see metrics.js note
  };
}

/** get_revenue_timeseries MCP tool backs onto this. */
export async function getRevenueTimeseries({ metric = 'total_billed', dateFrom, dateTo, filters } = {}) {
  return queryMetric(metric, { groupBy: 'ref_date', dateFrom, dateTo, filters });
}

/** get_region_breakdown / POP breakdown MCP tool backs onto this. */
export async function getPopBreakdown({ metric = 'total_billed', dateFrom, dateTo, filters } = {}) {
  return queryMetric(metric, { groupBy: 'pop_id', dateFrom, dateTo, filters });
}

/**
 * NEW 2026-09-17: real breakdown of total COLLECTED amount by
 * tran_mode_id -- the raw payment-channel code on fact_collection
 * (confirmed real column; 'tran_mode_id' is already a valid dimension for
 * total_collected in metrics.mjs, it just wasn't exposed as its own
 * standalone breakdown before -- only per-customer, via
 * getCustomerFinancials' collectedByTranMode). "Revenue by transaction
 * type" only makes sense against COLLECTED amount (a transaction mode is
 * how money was actually received, e.g. cash/bKash/bank transfer -- billed
 * amounts have no transaction mode, they haven't been paid yet), so this
 * intentionally does not also break down total_billed.
 *
 * tran_mode_id is NOT yet resolved to a human name (no TranModeMaster-style
 * reference table synced) -- rows come back as the raw numeric code only;
 * callers show it honestly as "Mode <id>", never invent a label.
 *
 * sortBy/direction/limit mirror getPopFinancials' contract -- set by the
 * caller (the model's own reading of "most/least revenue", "top N"), never
 * guessed here with a regex.
 */
export async function getTranModeBreakdown({
  dateFrom,
  dateTo,
  filters,
  limit,
  direction = 'desc',
} = {}) {
  const rows = await queryMetric('total_collected', { groupBy: 'tran_mode_id', dateFrom, dateTo, filters });
  let result = rows.map((r) => ({
    tranModeId: r.tran_mode_id ?? 'Unknown',
    collected: Number(r.value || 0),
  }));
  const sign = direction === 'asc' ? 1 : -1;
  result.sort((a, b) => sign * (a.collected - b.collected));
  if (Number.isFinite(limit) && limit > 0) {
    result = result.slice(0, limit);
  }
  return result;
}

/**
 * Transaction mode collected amount, crossed with POP or package --
 * closes the "mode by POP" / "mode by package" gap (previously mode only
 * cross-referenced with customer or the whole company). fact_collection
 * has tran_mode_id AND package_id as real direct columns; pop_id needs the
 * same dim_customer join JOIN_DIMENSIONS already uses everywhere else
 * (fact_collection has no direct pop_id -- see that map's own comment).
 * One row per (dimension value, tran_mode_id) pair.
 */
export async function getTranModeByDimension({ dimension, dateFrom, dateTo, filters } = {}) {
  if (dimension !== 'pop_id' && dimension !== 'package_id') {
    throw new Error('getTranModeByDimension: dimension must be "pop_id" or "package_id"');
  }
  const pool = getWarehousePool();
  const conditions = [];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`fc.ref_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`fc.ref_date <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  let query;
  if (dimension === 'package_id') {
    // fact_collection.package_id is real and direct -- no join needed.
    query = `
      SELECT fc.package_id AS dim_value, fc.tran_mode_id, SUM(fc.amount) AS amount
      FROM fact_collection fc
      ${whereClause}
      GROUP BY fc.package_id, fc.tran_mode_id
    `;
  } else {
    // pop_id: fact_collection has no direct pop_id -- join dim_customer,
    // same pattern as JOIN_DIMENSIONS.pop_id everywhere else in this file.
    query = `
      SELECT dc.pop_id AS dim_value, fc.tran_mode_id, SUM(fc.amount) AS amount
      FROM fact_collection fc
      LEFT JOIN dim_customer dc ON fc.customer_id = dc.customer_id
      ${whereClause}
      GROUP BY dc.pop_id, fc.tran_mode_id
    `;
  }
  const { rows } = await pool.query(query, params);

  const byDim = new Map();
  for (const r of rows) {
    const key = r.dim_value ?? 'Unknown';
    if (!byDim.has(key)) byDim.set(key, {});
    byDim.get(key)[r.tran_mode_id ?? 'Unknown'] = Number(r.amount || 0);
  }
  return [...byDim.entries()].map(([dimValue, byTranMode]) => ({ dimValue, byTranMode }));
}

/**
 * Real multi-metric per-POP breakdown: billed, collected, and outstanding
 * (billed - collected) together in ONE row per POP -- this is what backs
 * "total billed vs total collected for each POP" style questions. Previously
 * the only POP breakdown was getPopBreakdown() above, which takes exactly
 * ONE metric at a time, so a compound question like that could only ever
 * populate a single-column table (see report-table.ts's old 'pops'
 * fallback) -- this function exists so the table can honestly show both
 * numbers side by side instead of silently dropping one.
 *
 * `sortBy` / `direction` / `limit` are set by the CALLER (the MCP tool
 * layer, driven by the LLM's own reading of the question), not guessed
 * here or anywhere upstream with a regex over the user's raw text. A regex
 * like /top\s+(\d+)/ only ever catches the literal word "top" -- it has no
 * way to know "last 30", "bottom 10", or "lowest 5 by outstanding" mean the
 * same shape of request with the opposite direction. The model already
 * reads English natively; this function just needs a real sort/limit
 * argument to act on, not a re-implementation of language understanding in
 * JS. See server.mjs's get_pop_financials tool description for exactly how
 * the model is told to set these.
 */
export async function getPopFinancials({
  dateFrom,
  dateTo,
  filters,
  limit,
  sortBy = 'billed',
  direction = 'desc',
} = {}) {
  // NEW 2026-09-17: activeCustomers added alongside billed/collected/
  // refunded/adjusted -- active_customer_count already had pop_id as a
  // valid dimension (see metrics.mjs), it just was never fetched here
  // (only by package_id, in getPackageFinancials below). Real, same
  // point-in-time snapshot semantics as getActiveCustomerCount (no date
  // range applies to it -- see that function's own comment).
  const [billedRows, collectedRows, refundedRows, adjustedRows, activeCustomerRows] = await Promise.all([
    queryMetric('total_billed', { groupBy: 'pop_id', dateFrom, dateTo, filters }),
    queryMetric('total_collected', { groupBy: 'pop_id', dateFrom, dateTo, filters }),
    queryMetric('total_refunded', { groupBy: 'pop_id', dateFrom, dateTo, filters }),
    queryMetric('total_adjusted', { groupBy: 'pop_id', dateFrom, dateTo, filters }),
    queryMetric('active_customer_count', { groupBy: 'pop_id', filters }),
  ]);

  const collectedByPop = new Map(collectedRows.map((r) => [r.pop_id ?? 'Unassigned', Number(r.value || 0)]));
  const refundedByPop = new Map(refundedRows.map((r) => [r.pop_id ?? 'Unassigned', Number(r.value || 0)]));
  const adjustedByPop = new Map(adjustedRows.map((r) => [r.pop_id ?? 'Unassigned', Number(r.value || 0)]));
  const activeCustomersByPop = new Map(activeCustomerRows.map((r) => [r.pop_id ?? 'Unassigned', Number(r.value || 0)]));
  const pops = new Set([
    ...billedRows.map((r) => r.pop_id ?? 'Unassigned'),
    ...collectedByPop.keys(),
    ...refundedByPop.keys(),
    ...adjustedByPop.keys(),
    ...activeCustomersByPop.keys(),
  ]);

  const billedByPop = new Map(billedRows.map((r) => [r.pop_id ?? 'Unassigned', Number(r.value || 0)]));

  let rows = [...pops].map((pop) => {
    const billed = billedByPop.get(pop) ?? 0;
    const collected = collectedByPop.get(pop) ?? 0;
    const refunded = refundedByPop.get(pop) ?? 0;
    const adjusted = adjustedByPop.get(pop) ?? 0;
    const activeCustomers = activeCustomersByPop.get(pop) ?? 0;
    return { pop, billed, collected, refunded, adjusted, activeCustomers, outstanding: billed - collected };
  });

  // FIX 2026-09-17: real, deterministic insight fields -- computed here in
  // code, not left for the LLM's narrative step to eyeball or invent.
  // collectionRate = collected / billed (null when billed is 0, never a
  // divide-by-zero guess). billedShare = this POP's billed amount as a
  // fraction of TOTAL billed across ALL POPs in the result set -- computed
  // BEFORE the limit/slice below, so "top 10" still shows each POP's real
  // share of the FULL POP population, not just share-of-the-top-10 (which
  // would overstate concentration and mislead).
  const totalBilledAllPops = rows.reduce((sum, r) => sum + r.billed, 0);
  rows = rows.map((r) => ({
    ...r,
    collectionRate: r.billed > 0 ? r.collected / r.billed : null,
    billedShare: totalBilledAllPops > 0 ? r.billed / totalBilledAllPops : null,
  }));

  const sortKey = ['billed', 'collected', 'outstanding'].includes(sortBy) ? sortBy : 'billed';
  const sign = direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * (a[sortKey] - b[sortKey]));

  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

/**
 * Real per-CUSTOMER breakdown: total billed, total collected, and
 * outstanding (billed - collected) for the top N customers by revenue,
 * PLUS a real split of each customer's collected amount by tran_mode_id
 * (the raw payment-channel code from BillingMaster -- confirmed real
 * column, but not yet resolved to a human name; no TranModeMaster-style
 * reference table is synced yet, so tran_mode_name stays null. Showing
 * the raw code honestly here rather than inventing a label for it).
 *
 * customer_id is a real, direct column on both fact_billing and
 * fact_collection (confirmed against real INFORMATION_SCHEMA output --
 * not a guess), so this needs no dimension-table join the way pop_id
 * does. `limit`/`sortBy`/`direction` mirror getPopFinancials'/
 * getPackageFinancials' contract exactly.
 */
export async function getCustomerFinancials({
  dateFrom,
  dateTo,
  filters,
  limit = 100,
  sortBy = 'billed',
  direction = 'desc',
} = {}) {
  // NEW 2026-09-17: refunded/adjusted added -- customer_id is now a valid
  // dimension for total_refunded/total_adjusted (a REAL direct column on
  // fact_refund/fact_adjustment, no join needed, unlike pop_id/package_id
  // for these two tables). Fetched unconditionally across all customers
  // the same way billed/collected already are -- fact_refund/
  // fact_adjustment are tiny (tens of thousands of rows total, not
  // millions), so this is cheap, and doing it here (not only for the final
  // top-N slice, unlike the tran_mode join below) keeps sorting by
  // refunded/adjusted accurate against the full customer population.
  const [billedRows, collectedRows, refundedRows, adjustedRows] = await Promise.all([
    queryMetric('total_billed', { groupBy: 'customer_id', dateFrom, dateTo, filters }),
    queryMetric('total_collected', { groupBy: 'customer_id', dateFrom, dateTo, filters }),
    queryMetric('total_refunded', { groupBy: 'customer_id', dateFrom, dateTo, filters }),
    queryMetric('total_adjusted', { groupBy: 'customer_id', dateFrom, dateTo, filters }),
  ]);

  const billedByCustomer = new Map(billedRows.map((r) => [r.customer_id, Number(r.value || 0)]));
  const collectedByCustomer = new Map(collectedRows.map((r) => [r.customer_id, Number(r.value || 0)]));
  const refundedByCustomer = new Map(refundedRows.map((r) => [r.customer_id, Number(r.value || 0)]));
  const adjustedByCustomer = new Map(adjustedRows.map((r) => [r.customer_id, Number(r.value || 0)]));
  const customerIds = new Set([
    ...billedByCustomer.keys(),
    ...collectedByCustomer.keys(),
    ...refundedByCustomer.keys(),
    ...adjustedByCustomer.keys(),
  ]);

  let rows = [...customerIds]
    .filter((id) => id != null)
    .map((customerId) => {
      const billed = billedByCustomer.get(customerId) ?? 0;
      const collected = collectedByCustomer.get(customerId) ?? 0;
      const refunded = refundedByCustomer.get(customerId) ?? 0;
      const adjusted = adjustedByCustomer.get(customerId) ?? 0;
      return { customerId, billed, collected, refunded, adjusted, outstanding: billed - collected };
    });

  const sortKey = ['billed', 'collected', 'outstanding', 'refunded', 'adjusted'].includes(sortBy) ? sortBy : 'billed';
  const sign = direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * (a[sortKey] - b[sortKey]));

  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }

  // Only resolve names + tran_mode breakdown for the final top-N slice --
  // never join/aggregate this against all ~386k customers.
  const ids = rows.map((r) => r.customerId);
  if (ids.length) {
    const pool = getWarehousePool();
    const [{ rows: nameRows }, { rows: tranRows }, { rows: pkgRows }] = await Promise.all([
      pool.query(`SELECT customer_id, customer_name FROM dim_customer WHERE customer_id = ANY($1)`, [ids]),
      pool.query(
        `SELECT customer_id, tran_mode_id, SUM(amount) AS amount
         FROM fact_collection
         WHERE customer_id = ANY($1)
         GROUP BY customer_id, tran_mode_id`,
        [ids]
      ),
      // Package per customer -- dim_customer.package_id is the customer's
      // CURRENT package (not historical/per-transaction), same caveat as
      // pop_id/package_id everywhere else in this file via JOIN_DIMENSIONS.
      // Joined to dim_package for the real name, same pattern getPackageFinancials
      // itself uses. Only resolved for the final top-N slice, same as name/tranMode.
      pool.query(
        `SELECT dc.customer_id, dc.package_id, dp.package_name
         FROM dim_customer dc
         LEFT JOIN dim_package dp ON dp.package_id = dc.package_id
         WHERE dc.customer_id = ANY($1)`,
        [ids]
      ),
    ]);
    const nameById = new Map(nameRows.map((r) => [r.customer_id, r.customer_name]));
    const tranByCustomer = new Map();
    for (const r of tranRows) {
      if (!tranByCustomer.has(r.customer_id)) tranByCustomer.set(r.customer_id, {});
      tranByCustomer.get(r.customer_id)[r.tran_mode_id ?? 'Unknown'] = Number(r.amount || 0);
    }
    const pkgById = new Map(pkgRows.map((r) => [r.customer_id, { packageId: r.package_id, packageName: r.package_name }]));
    rows = rows.map((r) => ({
      ...r,
      customerName: nameById.get(r.customerId) ?? null,
      collectedByTranMode: tranByCustomer.get(r.customerId) ?? {},
      packageId: pkgById.get(r.customerId)?.packageId ?? null,
      packageName: pkgById.get(r.customerId)?.packageName ?? null,
    }));
  }

  return rows;
}

/**
 * Real multi-metric per-PACKAGE breakdown: total billed AND active customer
 * count together, one row per package. Verified real, not invented: both
 * total_billed (fact_billing) and active_customer_count (dim_customer)
 * list package_id as a valid dimension in metrics.mjs, and package_id is a
 * real synced column on both tables (BillingMaster.BID / CustomerMaster.
 * PackageID -- see etl/tables/billingMaster.mjs and customerMaster.mjs).
 * Real package names come from dim_package (BandwidthName, confirmed
 * against real PackageMaster columns -- see referenceTables.mjs).
 * UPDATED 2026-09-17: refunded/adjusted added -- package_id is now a valid
 * JOIN_DIMENSIONS-resolved dimension for total_refunded/total_adjusted too
 * (dim_customer.package_id, same pattern as pop_id -- see metrics.mjs's own
 * comment on that join for the "current package, not historical" caveat).
 * `limit`/`sortBy`/`direction` mirror getPopFinancials' contract exactly.
 */
export async function getPackageFinancials({
  dateFrom,
  dateTo,
  filters,
  limit,
  sortBy = 'billed',
  direction = 'desc',
} = {}) {
  const [billedRows, collectedRows, activeRows, refundedRows, adjustedRows] = await Promise.all([
    queryMetric('total_billed', { groupBy: 'package_id', dateFrom, dateTo, filters }),
    // FIX 2026-09-17: fact_collection.package_id is now real -- see this
    // file's ETL/schema comments (billingMaster.mjs, warehouse-schema.sql).
    // Previously this was genuinely unavailable and getPackageFinancials
    // said so honestly; now that the column carries real values, collected
    // (and therefore outstanding) is computed the same way getPopFinancials
    // already does for POPs.
    queryMetric('total_collected', { groupBy: 'package_id', dateFrom, dateTo, filters }),
    // active_customer_count is a point-in-time snapshot (dim_customer.status_id = 1)
    // -- it does not take a date range, matching getActiveCustomerCount's own
    // contract below. Passing dateFrom/dateTo here would silently be ignored
    // by queryMetric's WHERE clause anyway since dim_customer has no ref_date
    // column, so they're deliberately left out of this call, not forgotten.
    queryMetric('active_customer_count', { groupBy: 'package_id', filters }),
    // NEW 2026-09-17: refunded/adjusted by package, resolved via
    // dim_customer.package_id (the same JOIN_DIMENSIONS pattern as pop_id).
    queryMetric('total_refunded', { groupBy: 'package_id', dateFrom, dateTo, filters }),
    queryMetric('total_adjusted', { groupBy: 'package_id', dateFrom, dateTo, filters }),
  ]);

  const pool = getWarehousePool();
  const { rows: nameRows } = await pool.query('SELECT package_id, package_name FROM dim_package');
  const nameById = new Map(nameRows.map((r) => [String(r.package_id), r.package_name]));

  const billedByPackage = new Map(billedRows.map((r) => [r.package_id, Number(r.value || 0)]));
  const collectedByPackage = new Map(collectedRows.map((r) => [r.package_id, Number(r.value || 0)]));
  const activeByPackage = new Map(activeRows.map((r) => [r.package_id, Number(r.value || 0)]));
  const refundedByPackage = new Map(refundedRows.map((r) => [r.package_id, Number(r.value || 0)]));
  const adjustedByPackage = new Map(adjustedRows.map((r) => [r.package_id, Number(r.value || 0)]));
  const packages = new Set([
    ...billedByPackage.keys(),
    ...collectedByPackage.keys(),
    ...activeByPackage.keys(),
    ...refundedByPackage.keys(),
    ...adjustedByPackage.keys(),
  ]);

  let rows = [...packages].map((packageId) => {
    const billed = billedByPackage.get(packageId) ?? 0;
    const collected = collectedByPackage.get(packageId) ?? 0;
    const activeCustomers = activeByPackage.get(packageId) ?? 0;
    const refunded = refundedByPackage.get(packageId) ?? 0;
    const adjusted = adjustedByPackage.get(packageId) ?? 0;
    return {
      packageId,
      packageName: nameById.get(String(packageId)) ?? null,
      billed,
      collected,
      refunded,
      adjusted,
      outstanding: billed - collected,
      activeCustomers,
    };
  });

  // FIX 2026-09-17: same real, deterministic insight fields as
  // getPopFinancials -- computed here in code from the actual numbers,
  // never left for the narrative LLM step to eyeball or invent.
  // collectionRate = collected / billed (null when billed is 0).
  // billedShare = this package's billed amount as a fraction of TOTAL
  // billed across ALL packages -- computed BEFORE limit/slice, so a "top
  // 10 packages" answer still reports real share-of-total-business, not
  // share-of-the-top-10. revenuePerActiveCustomer = billed / activeCustomers
  // (null when activeCustomers is 0) -- tells you which packages are
  // actually valuable per customer, not just which have the biggest raw
  // total because they have many customers.
  const totalBilledAllPackages = rows.reduce((sum, r) => sum + r.billed, 0);
  rows = rows.map((r) => ({
    ...r,
    collectionRate: r.billed > 0 ? r.collected / r.billed : null,
    billedShare: totalBilledAllPackages > 0 ? r.billed / totalBilledAllPackages : null,
    revenuePerActiveCustomer: r.activeCustomers > 0 ? r.billed / r.activeCustomers : null,
  }));

  const sortKey = ['billed', 'collected', 'outstanding', 'activeCustomers'].includes(sortBy) ? sortBy : 'billed';
  const sign = direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * (a[sortKey] - b[sortKey]));

  if (Number.isFinite(limit) && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

/**
 * Real multi-metric DAILY timeseries: billed, collected, refunded, AND
 * adjusted together, one row per day. Verified real: total_billed,
 * total_collected, total_refunded, and total_adjusted ALL list ref_date as
 * a valid dimension in metrics.mjs (each backed by its own real ETL-synced
 * fact table -- fact_billing/fact_collection/fact_refund/fact_adjustment).
 * Previously get_revenue_timeseries only ever returned ONE of these four
 * per call, so a compound trend question ("billed vs collected vs
 * refunded over time") could only ever populate a single-line chart/table,
 * the same class of bug getPopFinancials fixed for POPs.
 */
export async function getRevenueTimeseriesFinancials({ dateFrom, dateTo, filters } = {}) {
  const [billedRows, collectedRows, refundedRows, adjustedRows] = await Promise.all([
    queryMetric('total_billed', { groupBy: 'ref_date', dateFrom, dateTo, filters }),
    queryMetric('total_collected', { groupBy: 'ref_date', dateFrom, dateTo, filters }),
    queryMetric('total_refunded', { groupBy: 'ref_date', dateFrom, dateTo, filters }),
    queryMetric('total_adjusted', { groupBy: 'ref_date', dateFrom, dateTo, filters }),
  ]);

  const isoDay = (d) => {
    const parsed = d instanceof Date ? d : new Date(d);
    return Number.isNaN(parsed.getTime()) ? String(d) : parsed.toISOString().slice(0, 10);
  };

  const billedByDay = new Map(billedRows.map((r) => [isoDay(r.ref_date), Number(r.value || 0)]));
  const collectedByDay = new Map(collectedRows.map((r) => [isoDay(r.ref_date), Number(r.value || 0)]));
  const refundedByDay = new Map(refundedRows.map((r) => [isoDay(r.ref_date), Number(r.value || 0)]));
  const adjustedByDay = new Map(adjustedRows.map((r) => [isoDay(r.ref_date), Number(r.value || 0)]));

  const allDays = new Set([...billedByDay.keys(), ...collectedByDay.keys(), ...refundedByDay.keys(), ...adjustedByDay.keys()]);

  return [...allDays].sort().map((day) => ({
    day,
    billed: billedByDay.get(day) ?? 0,
    collected: collectedByDay.get(day) ?? 0,
    refunded: refundedByDay.get(day) ?? 0,
    adjusted: adjustedByDay.get(day) ?? 0,
  }));
}

/** get_active_customer_count (dashboard KPI + future MCP tool) backs onto
 * this. Point-in-time count (status_id = 1) -- see metrics.mjs for why
 * this has no daily trend yet. Added here, not duplicated as raw SQL in
 * the dashboard layer, per this file's own "one implementation" rule. */
export async function getActiveCustomerCount({ filters } = {}) {
  const rows = await queryMetric('active_customer_count', { filters });
  return Number(rows[0]?.value || 0);
}
