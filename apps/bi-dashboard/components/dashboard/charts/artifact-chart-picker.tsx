'use client';

import { RevenueTrendChart } from '@/components/dashboard/charts/revenue-trend-chart';
import { GenericMetricChart } from '@/components/dashboard/charts/generic-metric-chart';
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
    return (
      <GenericMetricChart
        title={title}
        subtitle={`Tables used: ${data.metricBreakdown.tablesUsed.join(', ') || 'orders'}`}
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
