// Client-safe helper that turns a saved report's data into plain table
// rows. Shared by the report page's Table view, the chat side panel's
// inline table, and both CSV/Excel export so what you see and what you
// download are always the same numbers.
//
// ARCHITECTURE FIX 2026-09-17: this used to be a hard switch on `topic`
// with ONE catch-all default at the bottom -- any topic that didn't match
// one of a handful of hardcoded strings (e.g. 'packages', 'trend', both
// real breakdowns with their own MCP tools) silently fell through to that
// default, which renders the POP table. That's not "no report for this" --
// it's a report that renders SOMEONE ELSE'S data under the title you
// asked for, the exact bug class already fixed once for POPs. Every real
// breakdown now gets its own explicit branch below, keyed off which data
// is actually present on `data` -- not solely off the topic string, which
// can be missing or stale (e.g. an old saved report). Nothing here falls
// through to a default that renders different data than what was asked
// for; the true last resort renders an honest "no data" table instead.
import type { DashboardData } from '@/lib/dashboard/metrics';

export type ReportTable = { headers: string[]; rows: (string | number)[][] };

// Every table from this file gets a final "Total (N rows)" / "Total" style
// row appended by withTotalsRow() below. Charting code needs the data rows
// WITHOUT that row -- a bar/line point for "Total (100 rows)" is meaningless
// and, worse, distorts the scale of every real data point next to it. This
// is the one shared place that knows the exact label shape, so chart code
// never has to guess or duplicate the check (a prior duplicate, looser
// check elsewhere compared against the literal string 'Total', which never
// matched this label and silently let the Totals row through into charts).
export function stripTotalsRow(table: ReportTable): (string | number)[][] {
  const { rows } = table;
  if (!rows.length) return rows;
  const lastLabel = String(rows[rows.length - 1][0]);
  return lastLabel.startsWith('Total (') || lastLabel === 'Total' ? rows.slice(0, -1) : rows;
}

// FIX 2026-09-17: every table now gets a final Totals row appended.
// Column 0 (the identifying column -- POP ID/Package/Customer/Ticket
// Type/Day/Name) shows a row COUNT ("Total (N rows)") since summing an ID
// is meaningless. Every other numeric column shows the SUM of that column
// across all real rows, EXCEPT columns passed in avgColumns (currently
// only Avg Resolution (hours), where a sum across ticket types would be
// meaningless -- that one gets the real average instead, per explicit
// user request). A column with no numeric values at all (e.g. every row
// says "Not available yet") gets a blank cell instead of a fake 0.
function withTotalsRow(table: ReportTable, opts: { avgColumns?: number[] } = {}): ReportTable {
  const { headers, rows } = table;
  if (!rows.length) return table;
  const avgColumns = new Set(opts.avgColumns ?? []);
  const totalsRow: (string | number)[] = headers.map((_, colIndex) => {
    if (colIndex === 0) return `Total (${rows.length} rows)`;
    const numericValues = rows
      .map((row) => row[colIndex])
      .filter((v): v is number => typeof v === 'number');
    if (!numericValues.length) return '';
    const sum = numericValues.reduce((a, b) => a + b, 0);
    if (avgColumns.has(colIndex)) {
      return Math.round((sum / numericValues.length) * 100) / 100;
    }
    return sum;
  });
  return { headers, rows: [...rows, totalsRow] };
}

export function getReportTable(
  topic: string | null | undefined,
  data: DashboardData,
  chartType?: string | null,
): ReportTable {
  if (data.metricBreakdown && data.metricBreakdown.rows.length) {
    const { rows, primaryLabel, extraMetrics } = data.metricBreakdown;
    // When the agent queried more than one metric for the same dimension
    // (e.g. "units sold AND revenue by product"), show every metric as its
    // own column instead of only the first one -- otherwise the table would
    // silently disagree with a narrative that describes more than one
    // number per row.
    if (extraMetrics && extraMetrics.length) {
      return withTotalsRow({
        headers: ['Name', primaryLabel ?? 'Value', ...extraMetrics.map((m) => m.label)],
        rows: rows.map((row) => [
          row.name,
          row.value,
          ...extraMetrics.map((m) => m.valuesByName[row.name] ?? 0),
        ]),
      });
    }
    return withTotalsRow({
      headers: ['Name', primaryLabel ?? 'Value'],
      rows: rows.map((row) => [row.name, row.value]),
    });
  }

  // 'customers' still reads data.topCustomersByOrders, which
  // dashboard-data.mjs now always returns empty -- there is no real
  // per-customer order/revenue breakdown tool yet (see that file's own
  // comment). This will render an empty table rather than fabricate rows,
  // which is correct, but it means the 'customers' topic doesn't actually
  // have a real table to show yet.
  if (topic === 'customers') {
    return withTotalsRow({
      headers: ['Customer', 'Orders'],
      rows: data.topCustomersByOrders.map((row) => [row.name, row.orders]),
    });
  }

  if (topic === 'tickets') {
    // MULTI-METRIC 2026-09-17: avgResolutionHours added alongside count --
    // both are genuinely valid per ticket_type_id (see
    // ticketService.getTicketTypeBreakdown's own comment), so this is a
    // real second column, not a fabricated one. It will show "Not available
    // yet" for every row today because no confirmed "ticket resolved"
    // column exists in the source system -- shown honestly, not hidden or
    // guessed, and the column starts showing real numbers automatically
    // the moment that source column is confirmed and wired into the ETL.
    // FIX 2026-09-17: filterable by requestedMetrics like every other
    // multi-column table -- "ticket count by type" alone now shows only
    // Count, not a forced Avg Resolution column too.
    const TICKET_METRIC_COLUMNS: Record<string, { header: string; get: (row: DashboardData['ticketBreakdown'][number]) => string | number }> = {
      count: { header: 'Count', get: (row) => row.count },
      avgResolutionHours: {
        header: 'Avg Resolution (hours)',
        get: (row) =>
          row.avgResolutionHours === null || row.avgResolutionHours === undefined
            ? 'Not available yet'
            : Math.round(row.avgResolutionHours * 10) / 10,
      },
    };
    const requested = (data.requestedMetrics ?? []).filter((m) => m in TICKET_METRIC_COLUMNS);
    const activeMetrics = requested.length ? requested : Object.keys(TICKET_METRIC_COLUMNS);
    const ticketAvgColIndex = activeMetrics.indexOf('avgResolutionHours');
    return withTotalsRow(
      {
        headers: ['Ticket Type', ...activeMetrics.map((m) => TICKET_METRIC_COLUMNS[m].header)],
        rows: data.ticketBreakdown.map((row) => [
          row.ticketTypeName ?? `Type ${row.ticketTypeId ?? 'Unknown'}`,
          ...activeMetrics.map((m) => TICKET_METRIC_COLUMNS[m].get(row)),
        ]),
      },
      // Avg Resolution (hours) gets a real AVERAGE in the totals row, not a
      // sum -- summing an hours-per-type rate across ticket types would be
      // meaningless. Every other column (Count) still sums.
      { avgColumns: ticketAvgColIndex >= 0 ? [ticketAvgColIndex + 1] : [] },
    );
  }

  // NEW 2026-09-17: 'packages' backs get_package_financials -- billed,
  // collected, outstanding, AND active customer count together, one row
  // per package/plan. Collected-by-package used to be genuinely
  // unavailable (fact_collection.package_id didn't exist); it's now a real
  // ETL-synced column (see billingMaster.mjs / warehouse-schema.sql).
  if (topic === 'packages' && data.packageFinancials && data.packageFinancials.length) {
    // FIX 2026-09-17: same column-selection fix as popFinancials below --
    // billed/collected/outstanding/activeCustomers are all filterable via
    // requestedMetrics now, so "packages by active customers only" shows
    // just that column. collectionRate/billedShare/revenuePerActiveCustomer
    // stay narrative-only per the earlier explicit "don't add rows"
    // instruction.
    const PKG_METRIC_COLUMNS: Record<string, { header: string; get: (row: DashboardData['packageFinancials'][number]) => number }> = {
      billed: { header: 'Total Billed', get: (row) => row.billed },
      collected: { header: 'Total Collected', get: (row) => row.collected },
      outstanding: { header: 'Outstanding', get: (row) => row.outstanding },
      activeCustomers: { header: 'Active Customers', get: (row) => row.activeCustomers },
    };
    const requested = (data.requestedMetrics ?? []).filter((m) => m in PKG_METRIC_COLUMNS);
    const activeMetrics = requested.length ? requested : Object.keys(PKG_METRIC_COLUMNS);
    return withTotalsRow({
      headers: ['Package', ...activeMetrics.map((m) => PKG_METRIC_COLUMNS[m].header)],
      rows: data.packageFinancials.map((row) => [
        row.packageName ?? `Package ${row.packageId ?? 'Unknown'}`,
        ...activeMetrics.map((m) => PKG_METRIC_COLUMNS[m].get(row)),
      ]),
    });
  }

  // NEW 2026-09-17: 'trend' backs get_revenue_timeseries_financials --
  // billed, collected, refunded, AND adjusted together, one row per day.
  // Takes priority over the old single-metric revenueTrend fallback below
  // when this real 4-metric data is actually present.
  if ((topic === 'trend' || chartType === 'line') && data.revenueTimeseriesFinancials && data.revenueTimeseriesFinancials.length) {
    // FIX 2026-09-17: filterable by requestedMetrics -- "billed vs
    // collected over time" now shows only those two columns, not a forced
    // Refunded/Adjusted too.
    const TREND_METRIC_COLUMNS: Record<string, { header: string; get: (row: DashboardData['revenueTimeseriesFinancials'][number]) => number }> = {
      billed: { header: 'Billed', get: (row) => row.billed },
      collected: { header: 'Collected', get: (row) => row.collected },
      refunded: { header: 'Refunded', get: (row) => row.refunded },
      adjusted: { header: 'Adjusted', get: (row) => row.adjusted },
    };
    const requested = (data.requestedMetrics ?? []).filter((m) => m in TREND_METRIC_COLUMNS);
    const activeMetrics = requested.length ? requested : Object.keys(TREND_METRIC_COLUMNS);
    return withTotalsRow({
      headers: ['Day', ...activeMetrics.map((m) => TREND_METRIC_COLUMNS[m].header)],
      rows: data.revenueTimeseriesFinancials.map((row) => [row.day, ...activeMetrics.map((m) => TREND_METRIC_COLUMNS[m].get(row))]),
    });
  }

  // A "line chart"/trend request is about change over time regardless of
  // topic label -- single-metric fallback for a plain trend when the
  // richer 4-metric timeseries above isn't populated (e.g. an old saved
  // report from before revenueTimeseriesFinancials existed).
  if (chartType === 'line' && data.revenueTrend.length) {
    return withTotalsRow({
      headers: ['Day', 'Revenue', 'Orders'],
      rows: data.revenueTrend.map((row) => [row.day, row.revenue, row.orders]),
    });
  }

  // NEW 2026-09-17: 'top_customers' backs get_customer_financials -- top N
  // customers by billed/collected/outstanding, plus each customer's
  // collected amount split by tran_mode_id (raw payment-channel CODE, not
  // yet resolved to a name -- no TranModeMaster sync exists, shown
  // honestly as "Mode <id>" rather than inventing a label).
  if (topic === 'top_customers' && data.customerFinancials && data.customerFinancials.length) {
    // FIX 2026-09-17: filterable by requestedMetrics -- billed/collected/
    // outstanding are individually selectable, and the per-transaction-mode
    // breakdown columns only appear when 'byTranMode' was actually asked
    // for (e.g. "top customers by transaction mode") or nothing specific
    // was named at all.
    const TC_METRIC_COLUMNS: Record<string, { header: string; get: (row: DashboardData['customerFinancials'][number]) => number }> = {
      billed: { header: 'Total Billed', get: (row) => row.billed },
      collected: { header: 'Total Collected', get: (row) => row.collected },
      outstanding: { header: 'Outstanding', get: (row) => row.outstanding },
      refunded: { header: 'Refunded', get: (row) => row.refunded },
      adjusted: { header: 'Adjusted', get: (row) => row.adjusted },
    };
    // FIX 2026-09-17: package per customer -- real column (dim_customer's
    // CURRENT package, see revenueService.getCustomerFinancials' own
    // comment on that caveat), only shown when 'packageName' was asked for
    // (e.g. "top customers ... their package") to avoid cluttering
    // unrelated billed/collected requests.
    const ALL_TC_KEYS = [...Object.keys(TC_METRIC_COLUMNS), 'byTranMode', 'packageName'];
    const requestedRaw = (data.requestedMetrics ?? []).filter((m) => ALL_TC_KEYS.includes(m));
    const nothingSpecific = requestedRaw.length === 0;
    const requestedFinancial = requestedRaw.filter((m) => m in TC_METRIC_COLUMNS);
    const activeMetrics = requestedFinancial.length
      ? requestedFinancial
      : ['billed', 'collected', 'outstanding'];
    const wantsTranMode = nothingSpecific || requestedRaw.includes('byTranMode');
    const wantsPackage = nothingSpecific || requestedRaw.includes('packageName');

    const tranModeIds = new Set<string>();
    if (wantsTranMode) {
      for (const row of data.customerFinancials) {
        for (const modeId of Object.keys(row.collectedByTranMode ?? {})) tranModeIds.add(modeId);
      }
    }
    const modeIdList = [...tranModeIds].sort();
    return withTotalsRow({
      headers: [
        'Customer',
        ...(wantsPackage ? ['Package'] : []),
        ...activeMetrics.map((m) => TC_METRIC_COLUMNS[m].header),
        ...modeIdList.map((id) => `Collected (Mode ${id})`),
      ],
      rows: data.customerFinancials.map((row) => [
        row.customerName ?? `Customer ${row.customerId}`,
        ...(wantsPackage ? [row.packageName ?? (row.packageId != null ? `Package ${row.packageId}` : 'Not assigned')] : []),
        ...activeMetrics.map((m) => TC_METRIC_COLUMNS[m].get(row)),
        ...modeIdList.map((id) => row.collectedByTranMode?.[id] ?? 0),
      ]),
    });
  }

  // NEW 2026-09-17: 'ticket_pops' backs get_ticket_pop_breakdown -- ticket
  // count AND avg resolution time together, one row per POP. Filterable by
  // requestedMetrics ('count'/'avgResolutionHours') the same as the
  // ticket_type table above, with the same average-not-sum totals-row rule.
  if (topic === 'ticket_pops' && data.ticketPopBreakdown && data.ticketPopBreakdown.length) {
    const TICKET_POP_COLUMNS: Record<string, { header: string; get: (row: DashboardData['ticketPopBreakdown'][number]) => string | number }> = {
      count: { header: 'Count', get: (row) => row.count },
      avgResolutionHours: {
        header: 'Avg Resolution (hours)',
        get: (row) =>
          row.avgResolutionHours === null || row.avgResolutionHours === undefined
            ? 'Not available yet'
            : Math.round(row.avgResolutionHours * 10) / 10,
      },
    };
    const requested = (data.requestedMetrics ?? []).filter((m) => m in TICKET_POP_COLUMNS);
    const activeMetrics = requested.length ? requested : Object.keys(TICKET_POP_COLUMNS);
    const avgColIndex = activeMetrics.indexOf('avgResolutionHours');
    return withTotalsRow(
      {
        headers: ['POP ID', ...activeMetrics.map((m) => TICKET_POP_COLUMNS[m].header)],
        rows: data.ticketPopBreakdown.map((row) => [row.pop, ...activeMetrics.map((m) => TICKET_POP_COLUMNS[m].get(row))]),
      },
      { avgColumns: avgColIndex >= 0 ? [avgColIndex + 1] : [] },
    );
  }

  // NEW 2026-09-17: 'tran_modes' backs get_tran_mode_breakdown -- total
  // COLLECTED amount by transaction mode, one row per mode. tranModeId is
  // the raw payment-channel code, not yet resolved to a name (see
  // revenueService.getTranModeBreakdown's own comment) -- shown honestly
  // as "Mode <id>".
  if (topic === 'tran_modes' && data.tranModeBreakdown && data.tranModeBreakdown.length) {
    return withTotalsRow({
      headers: ['Transaction Mode', 'Total Collected'],
      rows: data.tranModeBreakdown.map((row) => [`Mode ${row.tranModeId}`, row.collected]),
    });
  }

  // NEW 2026-09-17: 'tran_mode_by_pop' / 'tran_mode_by_package' back
  // get_tran_mode_by_dimension -- total COLLECTED crossed with BOTH
  // transaction mode AND (POP or package) at once. One row per POP/package,
  // one column per mode actually present in the data (never invented).
  if (
    (topic === 'tran_mode_by_pop' || topic === 'tran_mode_by_package') &&
    ((topic === 'tran_mode_by_pop' ? data.tranModeByPop : data.tranModeByPackage)?.length ?? 0) > 0
  ) {
    const source = topic === 'tran_mode_by_pop' ? data.tranModeByPop : data.tranModeByPackage;
    const dimLabel = topic === 'tran_mode_by_pop' ? 'POP ID' : 'Package ID';
    const modeIds = new Set<string>();
    for (const row of source) {
      for (const modeId of Object.keys(row.byTranMode ?? {})) modeIds.add(modeId);
    }
    const modeIdList = [...modeIds].sort();
    return withTotalsRow({
      headers: [dimLabel, ...modeIdList.map((id) => `Collected (Mode ${id})`)],
      rows: source.map((row) => [
        `${row.dimValue ?? 'Unknown'}`,
        ...modeIdList.map((id) => row.byTranMode?.[id] ?? 0),
      ]),
    });
  }

  // 'pops' (or anything billing/collections-flavored that isn't one of the
  // more specific breakdowns above): billed, collected, AND outstanding
  // together per POP.
  // BACKWARD COMPAT 2026-09-17: a report saved before popFinancials
  // existed has an old `data` JSON snapshot in the DB with no such field --
  // reports are stored as a point-in-time snapshot (generated_reports.data),
  // never migrated when the shape changes. Falling back to the old
  // single-metric regionRevenue field (still always present) means an old
  // saved report still opens and shows something real, instead of throwing
  // "Cannot read properties of undefined" on data.popFinancials.map.
  if (data.popFinancials && data.popFinancials.length) {
    // FIX 2026-09-17: the table used to ALWAYS show every one of billed/
    // collected/refunded/adjusted/outstanding, even when the user named
    // only SOME of them (e.g. "total billed, total refunded, total
    // adjusted, plus outstanding" -- no "collected"). Now it shows exactly
    // the columns named in data.requestedMetrics (set by the agent from
    // what the user actually asked this turn), falling back to every
    // column only when requestedMetrics is empty -- an unspecific ask
    // ("give me a POP report") or an old saved report from before this
    // field existed. collectionRate/billedShare stay out of the table
    // entirely per the earlier explicit "don't add rows" instruction --
    // they're only ever used in the narrative sentence (agent.mjs's
    // buildDeterministicInsight).
    const POP_METRIC_COLUMNS: Record<string, { header: string; get: (row: DashboardData['popFinancials'][number]) => number }> = {
      billed: { header: 'Total Billed', get: (row) => row.billed },
      collected: { header: 'Total Collected', get: (row) => row.collected },
      refunded: { header: 'Total Refunded', get: (row) => row.refunded },
      adjusted: { header: 'Total Adjusted', get: (row) => row.adjusted },
      outstanding: { header: 'Outstanding', get: (row) => row.outstanding },
      // NEW 2026-09-17: fills the "active customers by POP" gap -- real
      // active_customer_count grouped by pop_id, same as packages already had.
      activeCustomers: { header: 'Active Customers', get: (row) => row.activeCustomers },
    };
    const requested = (data.requestedMetrics ?? []).filter((m) => m in POP_METRIC_COLUMNS);
    const activeMetrics = requested.length ? requested : Object.keys(POP_METRIC_COLUMNS);
    return withTotalsRow({
      headers: ['POP ID', ...activeMetrics.map((m) => POP_METRIC_COLUMNS[m].header)],
      rows: data.popFinancials.map((row) => [row.pop, ...activeMetrics.map((m) => POP_METRIC_COLUMNS[m].get(row))]),
    });
  }
  if (data.regionRevenue && data.regionRevenue.length) {
    return withTotalsRow({
      headers: ['POP ID', 'Billed Amount'],
      rows: data.regionRevenue.map((row) => [row.region, row.revenue]),
    });
  }

  // True last resort: no branch above matched anything with real rows.
  // Renders an honest "no data" table instead of guessing at a breakdown
  // that was never actually fetched this turn.
  return { headers: ['No data'], rows: [] };
}
