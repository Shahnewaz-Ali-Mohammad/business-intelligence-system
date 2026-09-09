'use client';

import { RegionRevenueChart } from '@/components/dashboard/charts/region-revenue-chart';
import { StatusDonutChart } from '@/components/dashboard/charts/status-donut-chart';
import { TopEntitiesBarChart } from '@/components/dashboard/charts/top-entities-bar-chart';
import { GenericMetricChart } from '@/components/dashboard/charts/generic-metric-chart';
import type { DashboardData } from '@/lib/dashboard/metrics';

// Picks which chart to render for a generated report/artifact based on what
// the conversation was actually about (topic) and, if the model produced a
// flexible metric+dimension breakdown, in whatever format the user asked for
// (chartType). Shared by the live chat artifact panel and the saved report
// detail page so a report looks the same way it did when it was generated,
// instead of every saved report defaulting back to "Revenue by Region".
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
      <TopEntitiesBarChart
        title="Top Customers by Orders"
        subtitle="users.id + orders (last window)"
        entries={data.topCustomersByOrders.map((row) => ({ name: row.name, value: row.orders }))}
        valueFormatter={(value) => `${value.toLocaleString('en-US')} orders`}
      />
    );
  }

  if (topic === 'products') {
    return (
      <TopEntitiesBarChart
        title="Top Products by Revenue"
        subtitle={data.chartSources.products}
        entries={data.topProductsChart.map((row) => ({ name: row.name, value: row.revenue }))}
        valueFormatter={(value) => `$${value.toLocaleString('en-US')}`}
      />
    );
  }

  if (topic === 'status' || topic === 'shipping') {
    return <StatusDonutChart data={data} />;
  }

  return <RegionRevenueChart data={data} />;
}
