// ============================================================================
// Real MCP server for the NEW warehouse-backed semantic layer. Mirrors the
// pattern already used by apps/bi-dashboard/scripts/mcp/bi-mcp-server.mjs
// (same SDK, same "expose a Resource for schema discovery + typed Tools for
// actions" shape) so swapping the dashboard over later is a drop-in, not a
// rewrite of how MCP is wired into the app.
//
// NOT yet wired into the live dashboard/chat pipeline on purpose — this
// server only returns real numbers once the warehouse has been populated
// by a successful ETL run (see src/etl/sync.mjs). Point the dashboard's
// LangGraph agent at this server (instead of the old bi-mcp-server.mjs)
// once that's true.
//
// Tool names match the ORIGINAL 10-point spec exactly (get_revenue_summary,
// get_revenue_timeseries, get_region_breakdown, get_ticket_metrics, etc.)
// — unlike the old server's single flexible query_semantic_layer tool, this
// uses explicit named tools per the requirement: "Direct, raw SQL creation
// by the LLM is strictly prohibited" + "explicit named MCP tools."
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getRevenueSummary, getRevenueTimeseries, getPopBreakdown, getPopFinancials, getPackageFinancials, getRevenueTimeseriesFinancials, getActiveCustomerCount, getCustomerFinancials, getTranModeBreakdown, getTranModeByDimension } from '../services/revenueService.mjs';
import { getTicketMetrics, getTicketTypeBreakdown, getTicketPopBreakdown } from '../services/ticketService.mjs';
import { METRICS } from '../semantic/metrics.mjs';

const SEMANTIC_CATALOG = `# BI Warehouse Semantic Catalog (read-only)

This is the ONLY source of business metrics for this system. Every number
here is computed from the Postgres warehouse (fact_*/dim_* tables), which
is itself synced daily from billGENIXDB + TicketingDB. No tool here ever
constructs or returns raw SQL.

## Billing / Collection (both sourced from BillingMaster, split by RefTypeID
-- confirmed with real production data, not assumed)
- total_billed: real charges (RefTypeID 1,2,3,7,8,10 -- INV_OTC, INV_MRC,
  INV_SHIFT, INV_OTHERS, DIRECT_SELL, DownChg), using Debit.
- total_collected: real cash received (RefTypeID 4, "MR" = Money Receipt),
  using Credit. Matches the business's own vw_Collection definition exactly.
- total_refunded: RefTypeID 5 (REFUND), recorded as Debit (NOT a negative
  collection -- refunds behave differently, kept as their own fact).
- total_adjusted: RefTypeID 6 (ADJUSTMENT), using Credit.

## Tickets
- ticket_volume, avg_resolution_hours: from fact_ticket (TicketingDB).
  NOTE: fact_ticket's source table is still a placeholder pending
  confirmation of TicketingDB's real ticket table -- see
  src/etl/tables/tickets.mjs header comment.

## Valid dimensions per metric
${Object.entries(METRICS)
  .map(([name, m]) => `- ${name}: ${m.validDimensions.join(', ') || '(none)'}`)
  .join('\n')}
`;

export function createWarehouseMcpServer() {
  const server = new McpServer({
    name: 'bi-warehouse-semantic-layer',
    version: '0.1.0',
  });

  server.registerResource(
    'warehouse-semantic-catalog',
    'schema://warehouse/catalog',
    {
      title: 'BI Warehouse Semantic Catalog',
      description: 'Which warehouse fact tables back each metric, and their confirmed RefTypeID mapping.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{ uri: 'schema://warehouse/catalog', mimeType: 'text/markdown', text: SEMANTIC_CATALOG }],
    }),
  );

  server.registerTool(
    'get_revenue_summary',
    {
      title: 'Get revenue summary',
      description:
        'Total billed, total collected, outstanding balance (billed minus collected), total refunded, and total adjusted, for a date range. Always call this before answering any billing/collection/revenue/refund/adjustment question.',
      inputSchema: {
        dateFrom: z.string().nullable().optional().describe('ISO date, e.g. "2026-01-01". Omit for all-time.'),
        dateTo: z.string().nullable().optional().describe('ISO date. Omit for up to today.'),
      },
    },
    async ({ dateFrom, dateTo }) => {
      const result = await getRevenueSummary({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    'get_revenue_timeseries',
    {
      title: 'Get revenue timeseries',
      description: 'Billed or collected amount over time, one row per day, for a date range.',
      inputSchema: {
        metric: z.enum(['total_billed', 'total_collected']).describe('Which amount to trend.'),
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
      },
    },
    async ({ metric, dateFrom, dateTo }) => {
      const result = await getRevenueTimeseries({ metric, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_region_breakdown',
    {
      title: 'Get POP/region breakdown',
      description: 'Billed or collected amount broken down by POP (service area / region).',
      inputSchema: {
        metric: z.enum(['total_billed', 'total_collected']).describe('Which amount to break down.'),
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
      },
    },
    async ({ metric, dateFrom, dateTo }) => {
      const result = await getPopBreakdown({ metric, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_pop_financials',
    {
      title: 'Get per-POP billed vs collected vs outstanding',
      description:
        'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count together, one row per POP. Always call this -- instead of get_region_breakdown -- for any question that asks for more than one of billed/collected/refunded/adjusted/outstanding/activeCustomers broken down by POP (e.g. "billed vs collected per POP", "outstanding by POP", "refunded and adjusted by POP", "active customers per POP", "detail for each POP"). Set limit/sortBy/direction from what the user actually asked -- see those arguments\' own descriptions. Do NOT fetch everything and trim it yourself; the tool does the sorting and limiting so the row count you get back is exactly what to report and table.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set this to N whenever the user named an explicit count -- "top 30", "last 30", "bottom 10", "highest 5", "worst 20" all mean limit: that number (30, 30, 10, 5, 20 respectively). Omit only when no count was named, to get the full POP list.'),
        sortBy: z
          .enum(['billed', 'collected', 'outstanding'])
          .nullable()
          .optional()
          .describe('Which column ranks the rows. Default "billed" fits a plain "top/last N POPs" with no metric named. If the user said "by outstanding"/"by collected", use that instead.'),
        direction: z
          .enum(['desc', 'asc'])
          .nullable()
          .optional()
          .describe('"desc" (default) for "top", "highest", "best", "most" -- largest values first. "asc" for "last", "bottom", "lowest", "worst", "smallest" -- smallest values first. Read the user\'s own word, never default to desc when they asked for the bottom/lowest/worst/last.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const result = await getPopFinancials({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_package_financials',
    {
      title: 'Get per-PACKAGE billed vs active customers',
      description:
        'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count together, one row per package (BandwidthName/package plan). Use this for any question that breaks billing, collections, refunds, adjustments, or active customers down by package/plan. Refunded/adjusted resolve via each customer\'s CURRENT package (dim_customer.package_id), not necessarily the package active on the refund/adjustment date.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set to whatever count the user named ("top 10", "last 5", "bottom 3" -> 10, 5, 3). Omit for the full package list.'),
        sortBy: z
          .enum(['billed', 'collected', 'outstanding', 'activeCustomers'])
          .nullable()
          .optional()
          .describe('Which column ranks the rows. Default "billed".'),
        direction: z
          .enum(['desc', 'asc'])
          .nullable()
          .optional()
          .describe('"desc" (default) for top/highest/most; "asc" for last/bottom/lowest/fewest -- read the user\'s own word.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const result = await getPackageFinancials({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_revenue_timeseries_financials',
    {
      title: 'Get daily billed vs collected vs refunded vs adjusted',
      description:
        'Billed, collected, refunded, AND adjusted amounts together, one row per day. Use this -- instead of get_revenue_timeseries -- for any trend question naming more than one of billed/collected/refunded/adjusted (e.g. "billed vs collected over time", "daily billed, collected, and refunded for the last 30 days"). get_revenue_timeseries still exists for a single-metric trend.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
      },
    },
    async ({ dateFrom, dateTo }) => {
      const result = await getRevenueTimeseriesFinancials({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_active_customer_count',
    {
      title: 'Get active customer count',
      description:
        'Real count of currently active customer accounts (dim_customer.status_id = 1, confirmed against real dim_status data -- 27 real status rows, status_id 1 = ACTIVE). Always call this for any question about how many active customers/subscribers exist -- never estimate or guess this number.',
      inputSchema: {},
    },
    async () => {
      const result = await getActiveCustomerCount({});
      return { content: [{ type: 'text', text: JSON.stringify({ activeCustomers: result }) }], structuredContent: { activeCustomers: result } };
    },
  );

  server.registerTool(
    'get_ticket_metrics',
    {
      title: 'Get ticket metrics',
      description:
        'Ticket volume and average resolution time, optionally broken down by department or ticket type. NOTE: source table is a placeholder pending confirmation (see semantic catalog resource) -- treat results as provisional until that is verified.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        groupBy: z.enum(['department_id', 'ticket_type_id']).nullable().optional(),
      },
    },
    async ({ dateFrom, dateTo, groupBy }) => {
      const result = await getTicketMetrics({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, groupBy: groupBy || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    'get_ticket_type_breakdown',
    {
      title: 'Get ticket volume AND avg resolution time by ticket type',
      description:
        'Real ticket COUNT and average resolution time TOGETHER, one row per ticket_type_id, with the real ticket_type_name joined in from dim_ticket_type where available (null if a type has no matching dimension row yet). Always call this for "what types of tickets" / "tickets by type" / "breakdown of ticket types" questions -- this breakdown IS available. If ticket_type_name is present, use the real name; if it is null for a row, report that row as "Type <id>" and say its name is not available yet. CRITICAL: avgResolutionHours will be null for every row -- no confirmed "ticket resolved" column exists in the source system yet. NEVER state a resolution-time number; if asked, say plainly it isn\'t available yet.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set to whatever count the user named ("top 10", "last 5") -- see get_pop_financials\' limit for the full convention. Omit for every ticket type.'),
        sortBy: z
          .enum(['count', 'avgResolutionHours'])
          .nullable()
          .optional()
          .describe('Which column ranks the rows. Default "count".'),
        direction: z
          .enum(['desc', 'asc'])
          .nullable()
          .optional()
          .describe('"desc" (default) for top/highest/most; "asc" for last/bottom/lowest/fewest.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const rows = await getTicketTypeBreakdown({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(rows) }], structuredContent: { rows } };
    },
  );

  server.registerTool(
    'get_customer_financials',
    {
      title: 'Get per-CUSTOMER billed vs collected (top N by revenue)',
      description:
        'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), each customer\'s CURRENT package (packageId/packageName, from dim_customer.package_id -- this is the customer\'s present package, not a historical per-transaction package), and each customer\'s collected amount split by tran_mode_id (raw payment-channel code -- NOT yet resolved to a human name like "cash"/"bKash", no TranModeMaster reference table is synced yet), one row per customer, ranked and limited. Use this for any "top N customers by revenue/billed/collected/outstanding/refunded/adjusted" question, "customer-level breakdown by transaction mode", or "top customers ... their package". customer_id is a real direct column on fact_billing, fact_collection, fact_refund, AND fact_adjustment.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set to whatever count the user named ("top 100" -> 100). Defaults to 100 if omitted.'),
        sortBy: z
          .enum(['billed', 'collected', 'outstanding'])
          .nullable()
          .optional()
          .describe('Which column ranks the rows. Default "billed".'),
        direction: z
          .enum(['desc', 'asc'])
          .nullable()
          .optional()
          .describe('"desc" (default) for top/highest/most; "asc" for last/bottom/lowest/fewest -- read the user\'s own word.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const result = await getCustomerFinancials({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_ticket_pop_breakdown',
    {
      title: 'Get ticket volume AND avg resolution time by POP',
      description:
        'Real ticket COUNT and average resolution time TOGETHER, one row per POP (resolved via each ticket\'s customer). Use this for "tickets by POP", "which POP has the most tickets", "support ticket breakdown by service area". CRITICAL: avgResolutionHours will be null for every row -- no confirmed "ticket resolved" column exists in the source system yet. NEVER state a resolution-time number; if asked, say plainly it isn\'t available yet.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z.number().int().positive().nullable().optional().describe('Set to whatever count the user named. Omit to return every POP.'),
        sortBy: z.enum(['count', 'avgResolutionHours']).nullable().optional().describe('Default "count".'),
        direction: z.enum(['desc', 'asc']).nullable().optional().describe('"desc" (default) for most/highest; "asc" for least/lowest.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const result = await getTicketPopBreakdown({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_tran_mode_breakdown',
    {
      title: 'Get total collected amount broken down by transaction mode',
      description:
        'Total COLLECTED amount (never billed -- a transaction mode is how money was actually received, so billed amounts have no mode) broken down by tran_mode_id, one row per mode, ranked and limited. Use this for "revenue/collected by transaction type", "which transaction mode brings the most revenue", "breakdown of collections by payment channel". tran_mode_id is the RAW payment-channel code, NOT yet resolved to a human name (no cash/bKash/Nagad label mapping is synced yet) -- report it as "Mode <id>", never invent what it means.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set to whatever count the user named. Omit to return every transaction mode.'),
        direction: z
          .enum(['desc', 'asc'])
          .nullable()
          .optional()
          .describe('"desc" (default) for most/highest revenue; "asc" for least/lowest -- read the user\'s own word.'),
      },
    },
    async ({ dateFrom, dateTo, limit, direction }) => {
      const result = await getTranModeBreakdown({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: limit || undefined,
        direction: direction || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  server.registerTool(
    'get_tran_mode_by_dimension',
    {
      title: 'Get transaction-mode collected amounts crossed with POP or package',
      description:
        'Total COLLECTED amount broken down by BOTH transaction mode AND (POP or package) at once, one row per POP/package with its own mode breakdown -- closes the gap where mode could previously only cross-reference with customer or the whole company. Use this for "transaction mode by POP", "collections by payment channel per package", "which POP collects the most cash vs mobile banking" style questions. Same NOTE as get_tran_mode_breakdown: tran_mode_id is the RAW code, report it as "Mode <id>", never invent what it means. package_id here is the real per-transaction package on fact_collection (not the customer\'s current package), pop_id is resolved via the customer (fact_collection has no direct pop_id).',
      inputSchema: {
        dimension: z.enum(['pop_id', 'package_id']).describe('Which dimension to cross transaction mode with.'),
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
      },
    },
    async ({ dimension, dateFrom, dateTo }) => {
      const result = await getTranModeByDimension({
        dimension,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { rows: result } };
    },
  );

  return server;
}
