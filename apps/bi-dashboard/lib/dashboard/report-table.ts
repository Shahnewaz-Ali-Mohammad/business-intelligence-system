// Client-safe helper that turns a saved report's chart data into plain
// table rows -- the exact same rows ArtifactChartPicker turns into a chart,
// just as a table instead. Shared by the report page's Table view and by
// both CSV/Excel export so what you see, what you toggle to, and what you
// download are always the same numbers.
import type { DashboardData } from '@/lib/dashboard/metrics';

export type ReportTable = { headers: string[]; rows: (string | number)[][] };

export function getReportTable(topic: string | null | undefined, data: DashboardData): ReportTable {
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

  if (topic === 'status' || topic === 'shipping') {
    return {
      headers: ['Status', 'Value'],
      rows: data.channelRevenue.map((row) => [row.name, row.value]),
    };
  }

  return {
    headers: ['Region', 'Revenue'],
    rows: data.regionRevenue.map((row) => [row.region, row.revenue]),
  };
}
