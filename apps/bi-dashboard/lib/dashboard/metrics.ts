import 'server-only';

import type { CustomerMix, Kpi, PageLink, TopCustomerByOrders } from '@/lib/dashboard/types';

export type DashboardData = {
  // FIX 2026-09-17: which financial columns (billed/collected/refunded/
  // adjusted/outstanding) the user actually named this turn, for
  // per-POP/per-package/per-customer tables -- empty/undefined means show
  // every available column (the correct default for an unspecific ask, and
  // for old saved reports that predate this field).
  requestedMetrics?: string[];
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
  popFinancials: { pop: string; billed: number; collected: number; refunded: number; adjusted: number; outstanding: number; activeCustomers: number; collectionRate: number | null; billedShare: number | null }[];
  packageFinancials: { packageId: string | number | null; packageName: string | null; billed: number; collected: number; outstanding: number; activeCustomers: number; collectionRate: number | null; billedShare: number | null; revenuePerActiveCustomer: number | null }[];
  revenueTimeseriesFinancials: { day: string; billed: number; collected: number; refunded: number; adjusted: number }[];
  customerFinancials: { customerId: string; customerName: string | null; billed: number; collected: number; outstanding: number; refunded: number; adjusted: number; packageId: string | null; packageName: string | null; collectedByTranMode: Record<string, number> }[];
  tranModeBreakdown: { tranModeId: string | number; collected: number }[];
  tranModeByPop: { dimValue: string | number; byTranMode: Record<string, number> }[];
  tranModeByPackage: { dimValue: string | number; byTranMode: Record<string, number> }[];
  ticketPopBreakdown: { pop: string; count: number; avgResolutionHours: number | null }[];
  ticketBreakdown: { ticketTypeId: string | number | null; ticketTypeName: string | null; count: number; avgResolutionHours: number | null }[];
  channelRevenue: { name: string; value: number; fill: string }[];
  topProducts: string[][];
  topProductsChart: { name: string; revenue: number }[];
  metricBreakdown: {
    rows: { name: string; value: number }[];
    tablesUsed: string[];
    primaryMetric?: string;
    primaryLabel?: string;
    groupBy?: string;
    extraMetrics?: { metric: string; label: string; valuesByName: Record<string, number>; tablesUsed: string[] }[];
    // Metrics the agent asked for that this dimension genuinely can't
    // compute (e.g. "units" for a per-customer breakdown) or that were
    // dropped for exceeding the 2-extra-metric cap -- surfaced so the UI
    // can be honest about it too, not just the chat reply.
    omittedMetrics?: { metric: string; label: string; fellBackTo?: string }[];
  } | null;
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
  // FIX 2026-09-17: true when this turn was the AI asking a clarifying
  // question rather than a grounded answer -- `intent` alone can't carry
  // this (it's normalized to 'answer' for the rest of the app's existing
  // contract), so the chat UI needs this separately to know not to treat
  // any leftover report panel as still answering the current question.
  askedClarification?: boolean;
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
