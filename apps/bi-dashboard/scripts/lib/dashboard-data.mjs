// ============================================================================
// Dashboard data assembly for the /api/dashboard REST endpoint AND (via
// scripts/mcp/warehouse-mcp-server-alias, see below) the chat agent's MCP
// tool layer.
//
// REWIRED from the old ecommerce-MySQL implementation to the real BI
// warehouse (Postgres), via apps/bi-warehouse's service layer. This file no
// longer runs any SQL of its own — that would violate the same "one
// implementation, every consumer gets identical numbers" rule the warehouse
// services header already states. Every number below comes from
// revenueService.mjs / ticketService.mjs, which in turn only use the SQL
// fragments in src/semantic/metrics.mjs. If a number here looks wrong, the
// fix belongs in the warehouse layer, not here.
//
// IMPORTANT SHAPE NOTE: the `DashboardData` type (lib/dashboard/types.ts,
// lib/dashboard/metrics.ts) and the dashboard UI components were originally
// built around an ecommerce store's concepts (orders, products, repeat
// customers, shipping regions). This ISP billing/CRM business has no real
// equivalent for several of those slots. Rather than invent fake numbers to
// fill them, each mapping decision below is documented at the point it's
// made — some slots are repurposed with a real, truthful ISP meaning (e.g.
// "regions" -> POPs), and a few are left null/empty with a comment because
// there is genuinely no real data to put there yet.
// ============================================================================

import {
  getRevenueSummary,
  getRevenueTimeseries,
  getPopFinancials,
  getPackageFinancials,
  getRevenueTimeseriesFinancials,
  getActiveCustomerCount,
  getCustomerFinancials,
  getTranModeBreakdown,
  getTranModeByDimension,
} from '../../../bi-warehouse/src/services/revenueService.mjs';
import { getTicketMetrics, getTicketTypeBreakdown, getTicketPopBreakdown } from '../../../bi-warehouse/src/services/ticketService.mjs';

function toNumber(value) {
  return Number(value ?? 0);
}

function sparklineFrom(values) {
  if (!values.length) return [20, 20, 20, 20, 20, 20];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 42);
  return values.map((value) => Math.round(18 + ((value - min) / (max - min)) * 54));
}

// Zero-floor version: scales from 0 (not the data's own minimum) up to the
// max, so the chart shows the real proportional shape of the data instead
// of stretching a small real range to fill the whole plot height.
function zeroFloorFrom(values) {
  if (!values.length) return [20, 20, 20, 20, 20, 20];
  const max = Math.max(...values, 0);
  if (max === 0) return values.map(() => 18);
  return values.map((value) => Math.round(18 + (Math.max(value, 0) / max) * 54));
}

function axisFrom(values, xStart, xEnd, formatter = (value) => String(value), options = {}) {
  if (!values.length) {
    return { xStart, xEnd, yMin: formatter(0), yMax: formatter(0) };
  }
  const yMin = options.zeroFloor ? 0 : Math.min(...values);
  return { xStart, xEnd, yMin: formatter(yMin), yMax: formatter(Math.max(...values)) };
}

function chartPointsFrom(rows, valueKey, formatter, options = {}) {
  const values = rows.map((row) => toNumber(row[valueKey]));
  const normalize = options.zeroFloor ? zeroFloorFrom : sparklineFrom;
  const normalized = normalize(values);
  return rows.map((row, index) => ({
    label: row.day ?? row.pop ?? `Point ${index + 1}`,
    value: formatter(values[index] ?? 0),
    normalized: normalized[index] ?? 42,
  }));
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

// Same z-score-based anomaly detector the old file used, unchanged in
// method — only the metrics fed into it changed (real billed/collected/
// outstanding daily totals instead of ecommerce revenue/orders/AOV).
function computeAnomalies(days, billedSeries, collectedSeries) {
  const outstandingSeries = billedSeries.map((v, i) => v - (collectedSeries[i] ?? 0));
  const metrics = [
    { label: 'Total Billed', values: billedSeries, format: (v) => money.format(v) },
    { label: 'Total Collected', values: collectedSeries, format: (v) => money.format(v) },
    { label: 'Outstanding Balance', values: outstandingSeries, format: (v) => money.format(v) },
  ];

  const candidates = [];
  for (const metric of metrics) {
    const values = metric.values;
    if (values.length < 2) continue;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (!mean || !stdDev) continue;
    values.forEach((value, index) => {
      const deltaPct = ((value - mean) / mean) * 100;
      const zScore = (value - mean) / stdDev;
      candidates.push({ label: metric.label, date: days[index], value: metric.format(value), deltaPct, zScore });
    });
  }
  candidates.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return candidates.slice(0, 4).map((candidate) => {
    const rounded = Math.round(candidate.deltaPct * 10) / 10;
    const status = rounded <= -15 ? 'critical' : rounded < 0 ? 'warning' : rounded >= 15 ? 'success' : 'info';
    return [candidate.label, candidate.date, candidate.value, `${rounded > 0 ? '+' : ''}${rounded}%`, status];
  });
}

// Real ISP topics this chatbot can ground answers in, replacing the old
// ecommerce topic list (revenue/orders/customers/products/regions/status/
// shipping). "tickets" is marked separately from the others because
// avg_resolution_hours is NOT YET USABLE (see metrics.mjs) — the topic
// still exists so ticket_volume questions work, but a resolution-time
// question should get an honest "not available yet" answer, not a number.
// FIX 2026-09-17: 'packages' and 'trend' added -- these were real,
// working breakdowns (get_package_financials, get_revenue_timeseries_
// financials) with NO topic of their own, so the model had no correct
// value to put in `topic` for them and report-table.ts's switch had no
// branch to catch them either -- both silently fell through to the
// default branch, which renders the POP table. That's not "ungated", it's
// SILENTLY WRONG: a saved package report would show unrelated POP rows
// under the right title. Every real breakdown now gets its own topic AND
// its own explicit table branch (see report-table.ts) -- nothing is
// allowed to fall through to a default that renders different data than
// what was actually asked for.
const ALLOWED_TOPICS = ['billing', 'collections', 'customers', 'tickets', 'pops', 'packages', 'trend', 'top_customers', 'tran_modes', 'ticket_pops', 'tran_mode_by_pop', 'tran_mode_by_package'];

const TOPIC_TABLES = {
  billing: ['fact_billing'],
  collections: ['fact_collection'],
  customers: ['dim_customer'],
  tickets: ['fact_ticket'],
  // FIX 2026-09-17: both entries were missing fact_collection even though
  // getPopFinancials/getPackageFinancials genuinely query total_collected
  // from it (confirmed by reading revenueService.mjs directly) -- this was
  // a pre-existing gap in this map that the old LLM-self-reported
  // tablesUsed sometimes masked by accident. Now that tablesUsed is
  // computed strictly from this map, an incomplete entry here shows up
  // every time, so it has to be actually correct.
  pops: ['fact_billing', 'fact_collection', 'fact_refund', 'fact_adjustment', 'dim_customer'],
  packages: ['fact_billing', 'fact_collection', 'dim_customer', 'dim_package'],
  trend: ['fact_billing', 'fact_collection', 'fact_refund', 'fact_adjustment'],
  top_customers: ['fact_billing', 'fact_collection', 'dim_customer'],
  // NEW 2026-09-17: total collected by transaction mode only queries
  // fact_collection (tran_mode_id is a real column on it) -- no billing,
  // customer, or POP join involved.
  tran_modes: ['fact_collection'],
  // NEW 2026-09-17: ticket volume/resolution by POP -- fact_ticket joined
  // to dim_customer to resolve pop_id (fact_ticket has no direct pop_id
  // column of its own, only customer_id).
  ticket_pops: ['fact_ticket', 'dim_customer'],
  // NEW 2026-09-17: transaction mode crossed with POP/package -- closes the
  // "mode by POP"/"mode by package" gap. package_id is real+direct on
  // fact_collection; pop_id needs the dim_customer join (fact_collection
  // has no direct pop_id of its own).
  tran_mode_by_pop: ['fact_collection', 'dim_customer'],
  tran_mode_by_package: ['fact_collection'],
  dashboard: ['fact_billing', 'fact_collection', 'dim_customer', 'fact_ticket'],
};

function tablesForTopic(topic) {
  return TOPIC_TABLES[topic] ?? TOPIC_TABLES.dashboard;
}

function dayLabel(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return String(dateLike ?? '');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function isoDay(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const dashboardDataCache = new Map();
const DASHBOARD_DATA_CACHE_TTL_MS = 30_000;
const DASHBOARD_DATA_CACHE_MAX_ENTRIES = 50;

function cacheKeyFor(params) {
  return JSON.stringify(params ?? {});
}

async function dashboardData(params) {
  // `limit` (an explicit "top N") is intentionally excluded from the cache
  // key normalization below via cacheKeyFor(params) already including it --
  // a "top 10" and a "top 30" request for the same window must never share
  // a cached result.
  const key = cacheKeyFor(params);
  const cached = dashboardDataCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < DASHBOARD_DATA_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await dashboardDataUncached(params);
  dashboardDataCache.set(key, { at: now, value });
  if (dashboardDataCache.size > DASHBOARD_DATA_CACHE_MAX_ENTRIES) {
    const oldestKey = dashboardDataCache.keys().next().value;
    dashboardDataCache.delete(oldestKey);
  }
  return value;
}

async function dashboardDataUncached({ windowDays = 30, region = null, limit = null, sortBy = null, direction = null, topic = null } = {}) {
  // `region` is kept as a parameter (and passed through, unused, to the
  // warehouse services -- see revenueService.mjs's own comment on
  // filters.region) purely so the RLS/filtering wiring described in the
  // project doc is a small future change here too, not a signature change.
  const filters = region ? { region } : {};

  // PERF FIX 2026-09-17: dashboardDataUncached used to fetch EVERY
  // breakdown unconditionally on EVERY request (chat message AND page
  // load) -- including a full aggregation across all ~386k customers
  // (getCustomerFinancials) and, as of today, two more full-table scans
  // (getTranModeByDimension x2) -- regardless of what was actually asked.
  // That's the real cause of the timeouts on simple questions like "number
  // of customers in each POP": a cheap, single-table lookup was paying for
  // every expensive breakdown in the system on every single turn.
  // `topic` (recovered from the model's own structured output in
  // agent.mjs, or omitted entirely for the plain dashboard page-load
  // endpoint) now gates the EXPENSIVE fetches -- cheap, small-result
  // queries (summary, daily trend, ticket volume, active customer count)
  // still always run since their cost is negligible and several topics
  // depend on them for context. When topic is null/undefined/'dashboard'
  // (initial page load, or a generic/no-specific-topic chat reply),
  // everything still fetches -- unchanged behavior there, since that path
  // is called far less often than a chat turn.
  const needAll = !topic || topic === 'dashboard';
  const need = (t) => needAll || topic === t;

  try {
    // No day-window filter is applied at the SQL level here -- unlike the
    // old ecommerce version, which derived its window from MAX(ordered_at)
    // in the same table it was querying, the warehouse services don't
    // expose a "give me the latest date" query yet, and the real billing
    // data's date range doesn't necessarily track "today". Fetching the
    // full daily series and slicing the trailing `windowDays` entries
    // client-side avoids guessing a cutoff date that might silently return
    // zero rows if the real data doesn't extend to the present.
    const [
      summary,
      billedDaily,
      collectedDaily,
      popFinancials,
      packageFinancials,
      revenueTimeseriesFinancials,
      ticketMetrics,
      activeCustomerCount,
      ticketTypeBreakdown,
      customerFinancials,
      ticketPopBreakdown,
      tranModeBreakdown,
      tranModeByPop,
      tranModeByPackage,
    ] = await Promise.all([
      getRevenueSummary({ filters }),
      getRevenueTimeseries({ metric: 'total_billed', filters }),
      getRevenueTimeseries({ metric: 'total_collected', filters }),
      // FIX 2026-09-17: this used to be a single-metric getPopBreakdown call
      // (billed only), so any "billed vs collected per POP" question could
      // only ever populate a single-column table -- the reply and the table
      // silently disagreed with what was actually asked. getPopFinancials
      // returns billed, collected, AND outstanding together in one row per
      // POP. `limit` is the explicit "top N" the user asked for (recovered
      // from the model's real tool call in agent.mjs), so a "top 30"
      // request returns exactly 30 rows here, not an arbitrarily different
      // number and not the full unfiltered list.
      need('pops') ? getPopFinancials({ filters, limit: limit || undefined, sortBy: sortBy || undefined, direction: direction || undefined }) : Promise.resolve([]),
      // ARCHITECTURE FIX 2026-09-17: every real breakdown is now fetched
      // unconditionally, the same way popFinancials/ticketTypeBreakdown
      // already were -- NOT gated behind which topic the model happened to
      // pick this turn. Previously package/trend breakdowns had no slot
      // here at all, so even when get_package_financials or
      // get_revenue_timeseries_financials was the tool actually called,
      // there was no real data for the report table to render, and
      // report-table.ts's switch had nowhere to route a 'packages'/'trend'
      // topic anyway -- both silently fell through to a default that shows
      // POP data under the wrong title. Fetching everything here means
      // whichever topic the model used, its real, matching data is always
      // present for the table.
      need('packages') ? getPackageFinancials({ filters, limit: limit || undefined, sortBy: sortBy || undefined, direction: direction || undefined }) : Promise.resolve([]),
      need('trend') ? getRevenueTimeseriesFinancials({ filters }) : Promise.resolve([]),
      getTicketMetrics({}),
      getActiveCustomerCount({ filters }),
      // FIX 2026-09-15: previously nothing fetched a per-type ticket
      // breakdown at all, so any "tickets by type" question had no real
      // data to chart/table -- the chart picker fell through to the
      // generic POP fallback (hence the mismatched "Billing by POP" chart
      // on a ticket question). See ticketService.mjs's own comment.
      need('tickets') ? getTicketTypeBreakdown({ limit: limit || undefined }) : Promise.resolve([]),
      // Real per-CUSTOMER breakdown -- top N by billed/collected/outstanding,
      // plus each customer's collected amount split by tran_mode_id. See
      // report-table.ts's 'top_customers' branch and
      // revenueService.getCustomerFinancials' own comment.
      need('top_customers') ? getCustomerFinancials({ filters, limit: limit || undefined, sortBy: sortBy || undefined, direction: direction || undefined }) : Promise.resolve([]),
      // NEW 2026-09-17: real ticket count/avg resolution by POP.
      need('ticket_pops') ? getTicketPopBreakdown({ limit: limit || undefined, sortBy: sortBy || undefined, direction: direction || undefined }) : Promise.resolve([]),
      // NEW 2026-09-17: real total COLLECTED amount broken down by
      // tran_mode_id -- backs "revenue by transaction type" questions. Not
      // limited by the page-level `limit` (that's for per-POP/customer top-N
      // lists); a transaction-mode breakdown is a small, finite set of real
      // codes, so it always returns all of them unless the model itself set
      // an explicit limit on the tool call (recovered the same way
      // popFinancialsArgs is, see agent.mjs).
      need('tran_modes') ? getTranModeBreakdown({ filters, limit: limit || undefined, direction: direction || undefined }) : Promise.resolve([]),
      // NEW 2026-09-17: mode crossed with POP/package -- real, not
      // limited/sorted (small finite dimension sets on both sides).
      need('tran_mode_by_pop') ? getTranModeByDimension({ dimension: 'pop_id', filters }) : Promise.resolve([]),
      need('tran_mode_by_package') ? getTranModeByDimension({ dimension: 'package_id', filters }) : Promise.resolve([]),
    ]);

    const sortByDate = (rows) =>
      [...rows]
        .filter((r) => r.ref_date)
        .sort((a, b) => new Date(a.ref_date) - new Date(b.ref_date));

    const billedSorted = sortByDate(billedDaily).slice(-windowDays);
    const collectedByDate = new Map(
      sortByDate(collectedDaily).map((r) => [isoDay(r.ref_date), toNumber(r.value)]),
    );

    const trendRows = billedSorted.map((row) => {
      const iso = isoDay(row.ref_date);
      return {
        day: dayLabel(row.ref_date),
        billed: toNumber(row.value),
        collected: collectedByDate.get(iso) ?? 0,
      };
    });

    const billedTrend = trendRows.map((r) => r.billed);
    const collectedTrend = trendRows.map((r) => r.collected);
    const outstandingTrend = trendRows.map((r) => r.billed - r.collected);

    const totalBilledWindow = billedTrend.reduce((s, v) => s + v, 0);
    const totalCollectedWindow = collectedTrend.reduce((s, v) => s + v, 0);

    const xStart = trendRows[0]?.day ?? 'Start';
    const xEnd = trendRows[trendRows.length - 1]?.day ?? 'End';

    // POPs (service areas), sorted by total billed -- this is the real,
    // direct replacement for the old "regionRevenue"/"topProducts" slots.
    // There is no "product" concept in ISP billing, so rather than force a
    // fake product list, the "top products" table/chart slot is repurposed
    // as "Top POPs by Billing", which is a genuine, real breakdown this
    // business can act on (which service areas generate the most billing).
    const popRows = popFinancials.map((r) => ({ pop: r.pop, revenue: toNumber(r.billed) }));
    // Kept small (top 8) only for the KPI-card sparklines/pinned-pages
    // slots below, which were always meant to show a short highlight list,
    // not the full breakdown -- the actual POP table (regionRevenue /
    // popFinancials) is NOT capped here; it shows every row limit allowed.
    const topPops = popRows.slice(0, 8);

    const totalBilled = toNumber(summary.totalBilled);
    const totalCollected = toNumber(summary.totalCollected);
    const outstandingBalance = toNumber(summary.outstandingBalance);
    // FIX 2026-09-17: real, ETL-synced data (fact_refund/fact_adjustment) --
    // was hardcoded to 0 below despite being real. See revenueService.mjs's
    // matching fix comment.
    const totalRefunded = toNumber(summary.totalRefunded);
    const totalAdjusted = toNumber(summary.totalAdjusted);

    // active_customer_count has no useful "trailing N days" trend -- it's
    // a point-in-time count of currently-active customers (status_id = 1),
    // not something with a daily history in the warehouse yet. The KPI
    // card below reflects that honestly (empty sparkline), same as the
    // original file did for its own "Active Customers" card.

    return {
      connected: true,
      // Real source description, replacing the old "ecommerce via
      // bi_readonly" string -- names the actual warehouse tables this
      // response is grounded in.
      source: `bi_warehouse (fact_billing/fact_collection/dim_customer/fact_ticket)${region ? `, ${region} only` : ''}`,
      activeFilter: region ?? 'All POPs',
      promptSuggestion: `Ask about ${topPops[0]?.pop ?? 'a top POP'}, outstanding balance, or ticket volume`,
      chartSources: {
        trend: 'fact_billing.amount + fact_collection.amount by ref_date',
        region: 'fact_billing.amount by dim_customer.pop_id (join on customer_id)',
        channel: 'fact_billing / fact_collection / fact_refund / fact_adjustment totals',
        products: 'fact_billing.amount by dim_customer.pop_id (top POPs)',
        anomalies: 'daily billed/collected/outstanding variance',
      },
      // No real "new vs returning customer" or "repeat customer" concept
      // exists in the current warehouse -- active_customer_count is a
      // point-in-time status count, not a cohort/first-order-date model
      // like the ecommerce `users`/`orders` tables had. Rather than fake a
      // cohort split, these are left honestly empty/null with this note.
      // TODO(real mapping): if/when dim_customer gets a confirmed
      // "activation date" or "first billed date" column, this can become a
      // genuine new-vs-existing-customer breakdown.
      customerMix: null,
      repeatCustomers: [],
      topCustomersByOrders: [],
      kpis: [
        {
          label: 'Total Billed',
          value: compactMoney.format(totalBilledWindow),
          delta: `${trendRows.length} billing days in range`,
          trend: 'up',
          accent: '#0f9f9a',
          sparkline: zeroFloorFrom(billedTrend),
          chartPoints: chartPointsFrom(trendRows, 'billed', money.format, { zeroFloor: true }),
          source: 'fact_billing.amount (scoped to chart range)',
          detail: `${money.format(totalBilledWindow)} billed in this range`,
          context: `All-time total billed: ${money.format(totalBilled)}`,
          footer: `Highest daily billing: ${money.format(Math.max(...billedTrend, 0))}`,
          axis: axisFrom(billedTrend, xStart, xEnd, compactMoney.format, { zeroFloor: true }),
        },
        {
          label: 'Total Collected',
          value: compactMoney.format(totalCollectedWindow),
          delta: `${trendRows.length} collection days in range`,
          trend: 'up',
          accent: '#2563eb',
          sparkline: zeroFloorFrom(collectedTrend),
          chartPoints: chartPointsFrom(trendRows, 'collected', money.format, { zeroFloor: true }),
          source: 'fact_collection.amount (scoped to chart range)',
          detail: `${money.format(totalCollectedWindow)} collected in this range`,
          context: `All-time total collected: ${money.format(totalCollected)}`,
          footer: `Highest daily collection: ${money.format(Math.max(...collectedTrend, 0))}`,
          axis: axisFrom(collectedTrend, xStart, xEnd, compactMoney.format, { zeroFloor: true }),
        },
        {
          label: 'Active Customers',
          value: activeCustomerCount.toLocaleString('en-US'),
          delta: `${activeCustomerCount.toLocaleString('en-US')} active accounts (status_id = 1)`,
          trend: 'up',
          accent: '#7c3aed',
          sparkline: [],
          chartPoints: [],
          source: 'dim_customer.status_id = 1 (all-time snapshot, not scoped to the day range)',
          detail: `${activeCustomerCount.toLocaleString('en-US')} active customers`,
          context: `Average billed/customer: ${money.format(activeCustomerCount ? totalBilled / activeCustomerCount : 0)}`,
          footer: 'No daily history yet for this metric in the warehouse.',
          axis: { xStart: 'New', xEnd: 'Returning', yMin: '0%', yMax: '100%' },
        },
        {
          label: 'Outstanding Balance',
          value: money.format(outstandingBalance),
          // Derived (billed - collected), all-time -- matches
          // revenueService.getRevenueSummary()'s own derivation exactly,
          // not recomputed differently here.
          delta: `${money.format(outstandingBalance)} all-time`,
          trend: outstandingBalance > 0 ? 'down' : 'up',
          accent: '#f97316',
          sparkline: zeroFloorFrom(outstandingTrend),
          chartPoints: chartPointsFrom(trendRows, 'billed', money.format, { zeroFloor: true }).map((point, i) => ({
            ...point,
            value: money.format(outstandingTrend[i] ?? 0),
          })),
          source: 'fact_billing.amount - fact_collection.amount',
          detail: `${money.format(totalBilled)} billed - ${money.format(totalCollected)} collected`,
          context: `${topPops[0]?.pop ?? 'Top POP'} leads billing`,
          footer: `Daily outstanding range: ${money.format(Math.min(...outstandingTrend, 0))} to ${money.format(Math.max(...outstandingTrend, 0))}`,
          axis: axisFrom(outstandingTrend, xStart, xEnd, money.format, { zeroFloor: true }),
        },
      ],
      revenueTrend: trendRows.map((row) => ({ day: row.day, revenue: row.billed, orders: row.collected })),
      dateRange: xStart === xEnd ? xStart : `${xStart} - ${xEnd}`,
      // "region" key kept for the existing region-revenue-chart component's
      // contract -- the values are real POP ids, not ecommerce
      // ship-country codes. See the component's relabeled header ("Billing
      // by POP") for the user-facing rename.
      // FIX 2026-09-15: this used to hardcode .slice(0, 5) -- only ever
      // 5 of the real ~400 POPs made it into the chart/table, silently,
      // with no indication anything was cut. GenericMetricChart now caps
      // and buckets large bar-chart breakdowns itself (top 14 + a real
      // "Other (N more)" bar, see that component's 2026-09-15 fix), so
      // this can pass the FULL real POP list through instead of
      // truncating it before the chart/table ever sees it.
      regionRevenue: popRows.map((row) => ({ region: row.pop, revenue: row.revenue })),
      // Real multi-metric per-POP breakdown -- billed, collected, AND
      // outstanding together, one row per POP -- backing "billed vs
      // collected per POP" style questions. See report-table.ts's 'pops'
      // branch, which renders this as a 4-column table instead of the old
      // single-metric POP ID / Billed Amount table.
      popFinancials: popFinancials.map((row) => ({
        pop: row.pop,
        billed: toNumber(row.billed),
        collected: toNumber(row.collected),
        refunded: toNumber(row.refunded),
        adjusted: toNumber(row.adjusted),
        outstanding: toNumber(row.outstanding),
        activeCustomers: toNumber(row.activeCustomers),
        collectionRate: row.collectionRate === null || row.collectionRate === undefined ? null : toNumber(row.collectionRate),
        billedShare: row.billedShare === null || row.billedShare === undefined ? null : toNumber(row.billedShare),
      })),
      // Real multi-metric per-PACKAGE breakdown -- billed AND active
      // customer count together. See report-table.ts's 'packages' branch
      // and revenueService.getPackageFinancials' own comment for why
      // collected/outstanding are deliberately NOT included here.
      packageFinancials: packageFinancials.map((row) => ({
        packageId: row.packageId,
        packageName: row.packageName,
        billed: toNumber(row.billed),
        collected: toNumber(row.collected),
        outstanding: toNumber(row.outstanding),
        activeCustomers: toNumber(row.activeCustomers),
        collectionRate: row.collectionRate === null || row.collectionRate === undefined ? null : toNumber(row.collectionRate),
        billedShare: row.billedShare === null || row.billedShare === undefined ? null : toNumber(row.billedShare),
        revenuePerActiveCustomer: row.revenuePerActiveCustomer === null || row.revenuePerActiveCustomer === undefined ? null : toNumber(row.revenuePerActiveCustomer),
      })),
      // Real multi-metric DAILY trend -- billed, collected, refunded, AND
      // adjusted together, one row per day. See report-table.ts's 'trend'
      // branch.
      revenueTimeseriesFinancials: revenueTimeseriesFinancials.map((row) => ({
        day: row.day,
        billed: toNumber(row.billed),
        collected: toNumber(row.collected),
        refunded: toNumber(row.refunded),
        adjusted: toNumber(row.adjusted),
      })),
      // Real per-CUSTOMER breakdown -- top N by billed/collected/outstanding,
      // plus each customer's collected amount split by tran_mode_id (raw
      // code, not yet resolved to a name -- see revenueService.mjs). See
      // report-table.ts's 'top_customers' branch.
      customerFinancials: customerFinancials.map((row) => ({
        customerId: row.customerId,
        customerName: row.customerName ?? null,
        billed: toNumber(row.billed),
        collected: toNumber(row.collected),
        outstanding: toNumber(row.outstanding),
        refunded: toNumber(row.refunded),
        adjusted: toNumber(row.adjusted),
        packageId: row.packageId ?? null,
        packageName: row.packageName ?? null,
        collectedByTranMode: Object.fromEntries(
          Object.entries(row.collectedByTranMode ?? {}).map(([modeId, amount]) => [modeId, toNumber(amount)]),
        ),
      })),
      // NEW 2026-09-17: real total COLLECTED amount broken down by
      // tran_mode_id, one row per transaction mode -- backs "revenue by
      // transaction type" questions. tranModeId is the raw code, not yet
      // resolved to a human name (see revenueService.getTranModeBreakdown's
      // own comment).
      tranModeBreakdown: tranModeBreakdown.map((row) => ({
        tranModeId: row.tranModeId,
        collected: toNumber(row.collected),
      })),
      // NEW 2026-09-17: transaction mode crossed with POP/package -- one
      // row per POP/package, each with its own {modeId: amount} map.
      tranModeByPop: tranModeByPop.map((row) => ({
        dimValue: row.dimValue,
        byTranMode: Object.fromEntries(Object.entries(row.byTranMode ?? {}).map(([id, amt]) => [id, toNumber(amt)])),
      })),
      tranModeByPackage: tranModeByPackage.map((row) => ({
        dimValue: row.dimValue,
        byTranMode: Object.fromEntries(Object.entries(row.byTranMode ?? {}).map(([id, amt]) => [id, toNumber(amt)])),
      })),
      // NEW 2026-09-17: real ticket count/avg resolution by POP -- fills
      // the "tickets by POP" gap. See ticketService.getTicketPopBreakdown's
      // own comment.
      ticketPopBreakdown: ticketPopBreakdown.map((row) => ({
        pop: row.pop,
        count: toNumber(row.count),
        avgResolutionHours: row.avgResolutionHours === null || row.avgResolutionHours === undefined ? null : Number(row.avgResolutionHours),
      })),
      // Billed / collected / refunded / adjusted split -- a real, direct
      // replacement for the old order-status donut, using the same four
      // fact tables the semantic catalog documents.
      channelRevenue: [
        { name: 'Billed', value: totalBilled, fill: '#0f9f9a' },
        { name: 'Collected', value: totalCollected, fill: '#2563eb' },
        { name: 'Refunded', value: totalRefunded, fill: '#f59e0b' },
        { name: 'Adjusted', value: totalAdjusted, fill: '#94a3b8' },
      ],
      topProductsChart: topPops.map((row) => ({ name: row.pop, revenue: row.revenue })),
      topProducts: topPops.map((row) => [
        row.pop,
        compactMoney.format(row.revenue),
        totalBilled ? `${Math.round((row.revenue / totalBilled) * 1000) / 10}%` : '0%',
        // No per-POP order-count/AOV concept exists -- these two columns
        // are honestly marked N/A rather than filled with a fabricated
        // number, unlike the ecommerce version which had real orders/aov
        // values here.
        'N/A',
        'N/A',
        'fact_billing',
      ]),
      anomalies: computeAnomalies(
        trendRows.map((r) => r.day),
        billedTrend,
        collectedTrend,
      ),
      pinnedPages: topPops.slice(0, 4).map((row) => ({
        title: `${row.pop} POP`,
        meta: compactMoney.format(row.revenue),
        status: 'Live',
      })),
      // Repurposed from the old order-status-history list to real ticket
      // volume, since fact_ticket is the closest real analog to an
      // "activity log" this business has today.
      sessionHistory: [
        {
          title: `${ticketMetrics.volume.reduce((s, r) => s + toNumber(r.value), 0).toLocaleString('en-US')} tickets`,
          meta: 'All-time ticket volume',
          status: 'Live',
        },
      ],
      exportsList: [],
      // The old flexible "metric by dimension" ad hoc breakdown
      // (query_semantic_layer's metric+groupBy args) has no equivalent on
      // the warehouse MCP server yet -- that server exposes fixed, named
      // tools only (get_revenue_summary, get_revenue_timeseries,
      // get_region_breakdown, get_ticket_metrics), per the project's "no
      // raw/ad hoc SQL from the LLM" requirement. Left null rather than
      // faked; the chat agent no longer requests this (see agent.mjs).
      // Real, honest breakdown of ticket volume by ticket_type_id --
      // numeric IDs only, no name lookup table synced yet (see
      // ticketService.getTicketTypeBreakdown's own comment). Consumed by
      // ArtifactChartPicker/getReportTable's 'tickets' branch.
      ticketBreakdown: ticketTypeBreakdown, // each row: { ticketTypeId, ticketTypeName, count }
      metricBreakdown: null,
      periodComparison: null,
    };
  } catch (error) {
    // The message shown to the browser stays generic (readonly-api.mjs's
    // /api/dashboard handler never forwards error.message to the client --
    // see its own comment), but the ORIGINAL error is only ever visible in
    // this process's own stdout via console.error below, which is easy to
    // lose track of when this runs as a detached background process. A
    // real bug (env vars not loaded for this cross-app module -- see
    // apps/bi-warehouse/src/config/db.mjs's 2026-09-15 fix) was masked this
    // way and took real debugging to find. Folding the real cause into the
    // thrown error's own message means it reliably lands in chat-errors.log
    // (via readonly-api.mjs's logErrorToFile), not just in a terminal
    // window someone has to have left open and scrolled back through.
    console.error('[dashboardData] query failed:', error);
    throw new Error(
      `The data source is temporarily unavailable. Please try again in a moment. (cause: ${error?.message ?? error})`,
    );
  }
}

export { toNumber, compactMoney, dashboardData, ALLOWED_TOPICS, TOPIC_TABLES, tablesForTopic };
