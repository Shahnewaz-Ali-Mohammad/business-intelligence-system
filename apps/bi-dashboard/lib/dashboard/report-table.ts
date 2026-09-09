// Client-safe helper that turns a saved report's chart data into plain
// table rows -- the exact same rows ArtifactChartPicker turns into a chart,
// just as a table instead. Shared by the report page's Table view and by
// both CSV/Excel export so what you see, what you toggle to, and what you
// download are always the same numbers. The branching here MUST stay in
// sync with ArtifactChartPicker's branching -- same topic/chartType in,
// same underlying series out, whichever form (chart or table) you're
// looking at.
import type { DashboardData } from '@/lib/dashboard/metrics';

export type ReportTable = { headers: string[]; rows: (string | number)[][] };

export function getReportTable(
  topic: string | null | undefined,
  data: DashboardData,
  chartType?: string | null,
): ReportTable {
  if (data.metricBreakdown && data.metricBreakdown.rows.length) {
    return {
      headers: ['Name', 'Value'],
      rows: data.metricBreakdown.rows.map((row) => [row.name, row.value]),
    };
  }

  if (topic === 'customers') {
    return {
      headers: ['Customer', 'Orders'],
      rows: data.topCustomersByOrders.map((row) => [row.name, row.orders]),
    };
  }

  if (topic === 'products') {
    return {
      headers: ['Product', 'Revenue'],
      rows: data.topProductsChart.map((row) => [row.name, row.revenue]),
    };
  }

  if (topic === 'orders' && data.revenueTrend.length) {
    return {
      headers: ['Day', 'Orders'],
      rows: data.revenueTrend.map((row) => [row.day, row.orders]),
    };
  }

  if (topic === 'status' || topic === 'shipping') {
    return {
      headers: ['Status', 'Value'],
      rows: data.channelRevenue.map((row) => [row.name, row.value]),
    };
  }

  // A "line chart"/trend request is about change over time regardless of
  // topic label -- match ArtifactChartPicker's trend branch so the table
  // shows the same day-by-day series instead of a region breakdown.
  if (chartType === 'line' && data.revenueTrend.length) {
    return {
      headers: ['Day', 'Revenue', 'Orders'],
      rows: data.revenueTrend.map((row) => [row.day, row.revenue, row.orders]),
    };
  }

  return {
    headers: ['Region', 'Revenue'],
    rows: data.regionRevenue.map((row) => [row.region, row.revenue]),
  };
}
