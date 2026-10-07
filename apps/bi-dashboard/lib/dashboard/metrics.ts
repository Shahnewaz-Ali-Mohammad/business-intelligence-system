import 'server-only';

import type { CustomerMix, Kpi, PageLink, TopCustomerByOrders } from '@/lib/dashboard/types';

export type DashboardData = {
  warehouseQuery?: { workspaceId: string; modelVersion: string; query: Record<string, unknown> };
  warehouseName?: string;
  // FIX 2026-09-17: which financial columns (billed/collected/refunded/
  // adjusted/outstanding) the user actually named this turn, for
  // per-POP/per-package/per-customer tables -- empty/undefined means show
  // every available column (the correct default for an unspecific ask, and
  // for old saved reports that predate this field).
  requestedMetrics?: string[];
  connected: boolean;
  activeCustomerCount?: number;
  financialSummary?: { billed: number; collected: number; refunded: number; adjusted: number; outstanding: number };
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
  popFinancials: { pop: string; popName?: string | null; billed: number; collected: number; refunded: number; adjusted: number; outstanding: number; activeCustomers: number; collectionRate: number | null; billedShare: number | null }[];
  packageFinancials: { packageId: string | number | null; packageName: string | null; billed: number; collected: number; refunded?: number; adjusted?: number; outstanding: number; activeCustomers: number; collectionRate: number | null; billedShare: number | null; revenuePerActiveCustomer: number | null }[];
  revenueTimeseriesFinancials: { day: string; billed: number; collected: number; refunded: number; adjusted: number }[];
  customerFinancials: { customerId: string; customerName: string | null; billed: number; collected: number; outstanding: number; refunded: number; adjusted: number; packageId: string | null; packageName: string | null; collectedByTranMode: Record<string, number> }[];
  // Whole-customer-base aggregate stats (customer_summary topic) -- NOT a
  // per-row list, see revenueService.getCustomerFinancialsSummary's own
  // comment on why a "give me every customer" question is answered with
  // statistics instead of one row per customer. null until that topic is
  // actually requested (see dashboard-data.mjs's need('customer_summary') gate).
  customerFinancialsSummary: {
    customerCount: number;
    totalBilled: number;
    totalCollected: number;
    totalOutstanding: number;
    avgBilled: number;
    avgCollected: number;
    avgOutstanding: number;
    medianBilled: number;
    medianOutstanding: number;
    p90Outstanding: number;
    customersWithOutstanding: number;
    topOutstanding: { customerId: string; outstanding: number }[];
    bottomOutstanding: { customerId: string; outstanding: number }[];
  } | null;
  tranModeBreakdown: { tranModeId: string | number; collected: number }[];
  tranModeByPop: { dimValue: string | number; byTranMode: Record<string, number> }[];
  tranModeByPackage: { dimValue: string | number; byTranMode: Record<string, number> }[];
  ticketPopBreakdown: { pop: string; count: number; avgResolutionHours: number | null }[];
  ticketBreakdown: { ticketTypeId: string | number | null; ticketTypeName: string | null; count: number; avgResolutionHours: number | null }[];
  // NEW 2026-10-01: individual ticket rows (get_ticket_list) -- real,
  // per-ticket data, not an aggregate. department_id is the raw id only
  // (see ticketService.getTicketList's own comment on why its name is
  // not resolved). resolved_date is always null today -- no confirmed
  // resolved-date column exists in the source system yet.
  // NEW 2026-10-01: query_semantic_layer's raw result, already shaped
  // as a table -- deliberately untyped beyond headers/rows (not a list
  // of named fields like every other entry here) because a Cube query
  // can ask for ANY combination of dimensions/measures the model
  // chooses per question. report-table.ts's 'semantic_query' branch
  // renders this as-is with no column-name hardcoding -- see that
  // branch's own comment for why this is the generic answer to
  // "show me whatever column/date-range I asked for", not a new
  // per-field enum to maintain forever.
  semanticQueryTable: { headers: string[]; rows: (string | number)[][] } | null;
  // NEW 2026-10-01: individual customer rows (get_customer_list), with
  // real pop/package/status names already joined in (see
  // customerService.getCustomerList's own comment).
  customerList: {
    customer_id: string;
    customer_name: string | null;
    pop_id: string | null;
    pop_name: string | null;
    package_id: string | null;
    package_name: string | null;
    status_id: string | null;
    status_name: string | null;
    entry_date: string | null;
    activated_date: string | null;
  }[];
  // FIX 2026-10-01: same reasoning as ticketListTotalCount below --
  // getCustomerList can cap at 5,000 rows; this is the real total.
  customerListTotalCount: number;
  ticketList: {
    ticket_sk: number;
    source_ticket_id: number | string;
    customer_id: string | null;
    department_id: string | null;
    ticket_type_id: string | null;
    ticket_type_name: string | null;
    opened_date: string | null;
    resolved_date: string | null;
    status: string | null;
  }[];
  // FIX 2026-10-01: the REAL total row count behind ticketList (which may
  // be capped at getTicketList's 5,000-row ceiling) -- see that function's
  // own comment. report-table.ts's 'ticket_list' branch uses this to add
  // an honest "showing X of Y" note instead of silently presenting a
  // capped slice as if it were the complete answer.
  ticketListTotalCount: number;
  // 2026-10-04: the exact filters behind ticketList/customerList, so the
  // paginated table and Excel export re-query the same set server-side.
  // Absent on reports saved before this existed.
  ticketListFilters?: {
    ticketTypeId: string | null;
    departmentId: string | null;
    status: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
  customerFinancialsQuery?: { sortBy: string; direction: string; limit: number; dateFrom?: string; dateTo?: string };
  customerFinancialsTotalCount?: number;
  semanticQuery?: Record<string, unknown>;
  chartQuery?: Record<string, unknown>;
  semanticQueryMaxRows?: number | null;
  semanticQueryTotalCount?: number;
  customerListFilters?: {
    dateField: string | null;
    dateFrom: string | null;
    dateTo: string | null;
    popId: string | null;
    packageId: string | null;
    statusId: string | null;
  };
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
