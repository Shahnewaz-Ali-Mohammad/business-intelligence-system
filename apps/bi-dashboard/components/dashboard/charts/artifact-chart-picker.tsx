'use client';

import { RevenueTrendChart } from '@/components/dashboard/charts/revenue-trend-chart';
import { GenericMetricChart } from '@/components/dashboard/charts/generic-metric-chart';
import { SmallMultiplesChart } from '@/components/dashboard/charts/small-multiples-chart';
import type { DashboardData } from '@/lib/dashboard/metrics';

// Picks which chart to render for a generated report/artifact based on what
// the conversation was actually about (topic) and honors whatever chart
// format was actually asked for (chartType) -- bar/line/pie/donut all work
// for customers, products, regions, and any flexible metric+dimension
// breakdown, via the one flexible GenericMetricChart. Only two cases keep a
// purpose-built chart: a genuine time-series trend (RevenueTrendChart, also
// used on the main dashboard) and status/shipping, which defaults to a
// donut (the natural shape for a status split) but still honors an
// explicit request for something else.
//
// This branching MUST stay in sync with getReportTable (lib/dashboard/
// report-table.ts) -- same topic/chartType in, same underlying series out,
// whichever form (chart or table) is showing.
export function ArtifactChartPicker({
  title,
  topic,
  chartType,
  data,
}: {
  title: string;
  topic?: string | null;
  chartType?: 'bar' | 'line' | 'pie' | 'donut' | 'none' | null;
  data: DashboardData;
}) {
  const resolvedChartType = chartType && chartType !== 'none' ? chartType : 'bar';

  if (data.metricBreakdown && data.metricBreakdown.rows.length) {
    const { tablesUsed, extraMetrics, primaryLabel, omittedMetrics } = data.metricBreakdown;
    // Anything the dimension genuinely couldn't compute at all
    // (omittedMetrics) is called out here, so the UI never quietly shows
    // fewer columns than were actually asked for with no explanation.
    const fellBack = omittedMetrics?.find((m) => m.fellBackTo);
    const genuinelyOmitted = omittedMetrics?.filter((m) => !m.fellBackTo) ?? [];
    const omissionNote =
      (fellBack ? ` (${fellBack.label} isn't available for this breakdown -- showing ${fellBack.fellBackTo} instead)` : '') +
      (genuinelyOmitted.length ? ` (${genuinelyOmitted.map((m) => m.label).join(', ')} not available for this breakdown)` : '');

    // A single chart can only honestly plot ONE series -- when more than
    // one metric was requested (e.g. "customers AND revenue by region"),
    // those numbers are typically on completely different scales (dollars
    // vs. a small headcount), so forcing them onto one shared axis either
    // squashes one series flat or needs a dual-axis chart, which is widely
    // considered bad practice (two independently-scaled axes make it easy
    // to make unrelated series LOOK correlated). Small multiples -- one
    // small chart per metric, same rows/order, each on its own real scale
    // -- is the honest way to show all of them visually instead of
    // silently dropping every metric but the first into a "see Table view"
    // footnote.
    if (extraMetrics && extraMetrics.length) {
      return (
        <div>
          <SmallMultiplesChart
            baseTitle={title}
            primaryLabel={primaryLabel ?? 'Value'}
            entries={data.metricBreakdown.rows}
            extraMetrics={extraMetrics}
            chartType={resolvedChartType}
          />
          {omissionNote ? <p className="mt-2 text-xs text-slate-500">{omissionNote.trim()}</p> : null}
        </div>
      );
    }

    return (
      <GenericMetricChart
        title={title}
        subtitle={`Tables used: ${tablesUsed.join(', ') || 'orders'}${omissionNote}`}
        entries={data.metricBreakdown.rows}
        chartType={resolvedChartType}
      />
    );
  }

  if (topic === 'customers') {
    return (
      <GenericMetricChart
        title="Top Customers by Orders"
        subtitle="users.id + orders (last window)"
        entries={data.topCustomersByOrders.map((row) => ({ name: row.name, value: row.orders }))}
        chartType={resolvedChartType}
      />
    );
  }

  if (topic === 'products') {
    return (
      <GenericMetricChart
        title="Top Products by Revenue"
        subtitle={data.chartSources.products}
        entries={data.topProductsChart.map((row) => ({ name: row.name, value: row.revenue }))}
        chartType={resolvedChartType}
      />
    );
  }

  if (topic === 'orders' && data.revenueTrend.length) {
    // A plain "orders" report is about order volume, not revenue-by-region
    // (the generic fallback below) -- show order count per day, honoring
    // whatever chart format was actually asked for.
    return (
      <GenericMetricChart
        title="Order Volume"
        subtitle={data.dateRange ? `Orders per day, ${data.dateRange}` : 'Orders per day'}
        entries={data.revenueTrend.map((row) => ({ name: row.day, value: row.orders }))}
        chartType={resolvedChartType}
      />
    );
  }

  if (topic === 'status' || topic === 'shipping') {
    // Donut is the natural shape for "what share is each status" -- but if
    // a specific format was actually asked for, honor it instead.
    const statusChartType = chartType && chartType !== 'none' ? chartType : 'donut';
    return (
      <GenericMetricChart
        title="Orders by Status"
        subtitle={data.chartSources.channel}
        entries={data.channelRevenue.map((row) => ({ name: row.name, value: row.value }))}
        chartType={statusChartType}
      />
    );
  }

  // A "line chart" / trend request is about change over time regardless of
  // topic label ("revenue trend", "orders over time", "show that as a line
  // chart") -- honor it with the real time-series chart before falling
  // back to a static region breakdown.
  if (resolvedChartType === 'line' && data.revenueTrend.length) {
    return <RevenueTrendChart data={data} />;
  }

  return (
    <GenericMetricChart
      title="Revenue by Region"
      subtitle={data.chartSources.region}
      entries={data.regionRevenue.map((row) => ({ name: row.region, value: row.revenue }))}
      chartType={resolvedChartType}
    />
  );
}
