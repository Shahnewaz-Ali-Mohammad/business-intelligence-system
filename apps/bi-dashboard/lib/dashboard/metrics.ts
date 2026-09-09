import 'server-only';

import type { CustomerMix, Kpi, PageLink, TopCustomerByOrders } from '@/lib/dashboard/types';

export type DashboardData = {
  connected: boolean;
  source: string;
  dateRange: string;
  activeFilter: string;
  promptSuggestion: string;
  chartSources: {
    trend: string;
    region: string;
    channel: string;
    products: string;
    anomalies: string;
  };
  kpis: Kpi[];
  customerMix: CustomerMix | null;
  repeatCustomers: string[][];
  topCustomersByOrders: TopCustomerByOrders[];
  revenueTrend: { day: string; revenue: number; orders: number }[];
  regionRevenue: { region: string; revenue: number }[];
  channelRevenue: { name: string; value: number; fill: string }[];
  topProducts: string[][];
  topProductsChart: { name: string; revenue: number }[];
  metricBreakdown: { rows: { name: string; value: number }[]; tablesUsed: string[] } | null;
  anomalies: string[][];
  pinnedPages: PageLink[];
  sessionHistory: PageLink[];
  exportsList: string[];
};

export type DashboardFilters = {
  days?: number;
  region?: string | null;
};

export type ChatResponse = {
  intent: 'answer' | 'mutate_current_page' | 'create_new_page';
  topic?: string;
  chartType?: 'bar' | 'line' | 'pie' | 'donut' | 'none';
  title: string;
  narrative: string;
  filters: {
    days: number;
    region: string | null;
  };
  tablesUsed: string[];
  data: DashboardData | null;
};

export async function getHomeDashboardData(
  filters: DashboardFilters = {},
): Promise<DashboardData> {
  const apiUrl = process.env.READONLY_API_URL ?? 'http://localhost:4100/api/dashboard';
  const url = new URL(apiUrl);
  if (filters.days) url.searchParams.set('days', String(filters.days));
  if (filters.region) url.searchParams.set('region', filters.region);

  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard data API failed: ${body}`);
  }

  return response.json() as Promise<DashboardData>;
}
