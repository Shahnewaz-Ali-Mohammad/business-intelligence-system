// ============================================================================
// The REAL, LIVE MCP server for the warehouse-backed semantic layer.
// Registered as 'bi-warehouse-semantic-layer' and loaded by
// apps/bi-dashboard/scripts/chat/agent.mjs (getAgentTools/loadMcpTools) --
// every chat answer's data comes from the tools registered here.
//
// (UPDATE 2026-09-27: the header above used to say this was "not yet
// wired in" -- that was true when this file was first written, but it has
// been the live server for a while now; the old placeholder demo server
// apps/bi-dashboard/scripts/mcp/bi-mcp-server.mjs it was compared against
// has since been deleted as dead code.)
//
// Tool names match the ORIGINAL 10-point spec exactly (get_revenue_summary,
// get_revenue_timeseries, get_region_breakdown, get_ticket_metrics, etc.),
// per the requirement: "Direct, raw SQL creation by the LLM is strictly
// prohibited" + "explicit named MCP tools" -- no free-form query tool
// exists anywhere in this server.
//
// Request flow for one chat message, end to end (see agent.mjs for the
// fuller version of this map):
//   1. apps/bi-dashboard app/api/chat/route.ts (authenticated proxy)
//   2. apps/bi-dashboard scripts/readonly-api.mjs (HTTP entrypoint)
//   3. apps/bi-dashboard scripts/chat/agent.mjs (LangGraph agent: decides
//      which tool(s) below to call, drafts a narrative, critiques it)
//   4. THIS FILE -- the actual named tools the agent can call
//   5. apps/bi-warehouse src/services/*.mjs -- the real SQL, one file per
//      domain (revenueService.mjs, ticketService.mjs)
//   6. separately, apps/bi-dashboard scripts/lib/dashboard-data.mjs calls
//      the SAME services directly (step 5) to build the actual table/
//      chart the user sees -- this never goes through steps 3/4, which is
//      why a row-limit cap on a tool here (see MAX_RANKED_LIMIT/
//      MAX_CUSTOMER_LIMIT below) only protects the LLM's own reasoning,
//      never what the user's table/export actually shows.
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getRevenueSummary, getRevenueTimeseries, getPopBreakdown, getPopFinancials, getPackageFinancials, getRevenueTimeseriesFinancials, getActiveCustomerCount, getCustomerFinancials, getCustomerFinancialsSummary, getTranModeBreakdown, getTranModeByDimension } from '../services/revenueService.mjs';
import { getTicketMetrics, getTicketTypeBreakdown, getTicketPopBreakdown } from '../services/ticketService.mjs';
import { METRICS } from '../semantic/metrics.mjs';

// FIX 2026-09-26: every ranked/limited tool below let the model pass ANY
// positive `limit` with no ceiling -- a real request for "1000 top
// customers" set limit: 1000, which ran fine in SQL (already fixed to
// push ORDER BY + LIMIT into the query, not aggregate-then-slice in JS),
// but then serialized all 1000 rows' full JSON -- including each
// customer's nested per-transaction-mode breakdown object -- straight into
// the LLM's context TWICE (draft model, then the critique/fact-check
// model). Confirmed via live error: OpenAI rejected it outright --
// "maximum context length is 128000 tokens... your messages resulted in
// 172771 tokens" -- which is exactly the generic, unhelpful "Could not
// handle chat request" the user saw, ~90 seconds after asking, with no
// indication of why. These caps make an over-large request fail
// INSTANTLY, before any DB or OpenAI call, with a schema-validation error
// the model can see and correct (e.g. by asking for fewer rows or paging),
// rather than a slow, opaque, expensive full round-trip that was always
// going to fail anyway.
//
// MAX_CUSTOMER_LIMIT is lower than the others because get_customer_financials'
// rows are the heaviest -- each one carries a full nested
// collectedByTranMode breakdown object, not just a handful of numbers.
const MAX_RANKED_LIMIT = 500;
const MAX_CUSTOMER_LIMIT = 300;

// FIX 2026-09-26 (part 2): a hard `.max()` on the schema made an
// over-large `limit` REJECT the tool call outright (a Zod validation
// error), which can abort the whole agent turn instead of degrading
// gracefully. Soft-clamping here instead means the call always succeeds:
// it silently returns at most the cap's worth of rows to the LLM (for its
// own reasoning/narrative -- the real, full-size table and Excel export
// are built separately, straight from the database, and are NOT limited
// by this cap at all -- see dashboardData() in
// apps/bi-dashboard/scripts/lib/dashboard-data.mjs). The LLM is told in
// plain text when this happened, so it can mention it rather than silently
// under-reporting.
function capLimitForLlm(limit, cap) {
  // FIX 2026-09-28: an OMITTED limit (the LLM correctly leaves it out for
  // "every POP" / "detail for each POP" / "the whole report" -- see each
  // tool's own limit description) used to fall through this function
  // completely uncapped, because `typeof undefined !== 'number'` short-
  // circuited the check below before it ever got a chance to compare
  // against `cap`. That dumped the FULL, unbounded row set into the
  // draft AND critique LLM calls for a big warehouse (hundreds of POPs,
  // thousands of customers) -- slow enough on its own to blow past
  // readonly-api.mjs's 150s timeout, and for a large enough result the
  // same shape of bug as the ContextOverflowError already seen in
  // chat-errors.log for a different unbounded query. An omitted limit
  // now defaults to the cap for what the LLM sees, exactly like an
  // explicit over-cap limit does -- the real report/table/export the
  // user sees is still built separately from the full, uncapped result
  // (see dashboardData() in apps/bi-dashboard/scripts/lib/dashboard-data.mjs),
  // so nothing the user actually sees gets smaller, only what's fed back
  // into the model.
  const requested = typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
  if (requested !== null && requested <= cap) {
    return { effectiveLimit: requested, note: null };
  }
  if (requested === null) {
    return {
      effectiveLimit: cap,
      note: `Showing the top ${cap} (by the default sort) here for analysis to stay within model context limits, since no specific count was requested. This does NOT limit the actual report/table/export the user sees -- that is generated separately from the complete, unbounded result.`,
    };
  }
  return {
    effectiveLimit: cap,
    note: `You asked for ${requested} rows; showing the top ${cap} here for analysis to stay within model context limits. This does NOT limit the actual report/table/export the user sees -- that is generated separately from the full ${requested}-row result.`,
  };
}

function withLlmNote(rows, note) {
  return note ? { note, rows } : rows;
}

// FIX 2026-09-27: five of the tools below (POP, package, ticket-type,
// ticket-by-POP, transaction-mode) were each hand-writing the exact same
// handler shape -- capLimitForLlm, call the service, wrap the result with
// withLlmNote -- differing only in which service function to call. Their
// titles/descriptions/input schemas stay fully hand-written below (that
// wording carries real per-tool nuance the model relies on, and
// templating it would blur that for the sake of fewer lines); only the
// mechanical, truly-identical handler body is shared here.
// get_customer_financials is deliberately NOT included -- it has three
// genuinely unique behaviors (includeTranModeBreakdown, stripping the
// nested breakdown, aggregate totals in its note) that would make this
// shared function more convoluted for one outlier rather than simpler.
function registerRankedTool(server, { name, title, description, inputSchema, cap, service }) {
  server.registerTool(
    name,
    { title, description, inputSchema },
    async ({ dateFrom, dateTo, limit, sortBy, direction }) => {
      const { effectiveLimit, note } = capLimitForLlm(limit, cap);
      const result = await service({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: effectiveLimit,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(withLlmNote(result, note)) }],
        structuredContent: { rows: result, note },
      };
    },
  );
}

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

  registerRankedTool(server, {
    name: 'get_pop_financials',
    title: 'Get per-POP billed vs collected vs outstanding',
    description:
      'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count together, one row per POP. Always call this -- instead of get_region_breakdown -- for any question that asks for more than one of billed/collected/refunded/adjusted/outstanding/activeCustomers broken down by POP (e.g. "billed vs collected per POP", "outstanding by POP", "refunded and adjusted by POP", "active customers per POP", "detail for each POP"). Set limit/sortBy/direction from what the user actually asked -- see those arguments\' own descriptions. Do NOT fetch everything and trim it yourself; the tool does the sorting and limiting so the row count you get back is exactly what to report and table.',
    cap: MAX_RANKED_LIMIT,
    service: getPopFinancials,
    inputSchema: {
      dateFrom: z.string().nullable().optional(),
      dateTo: z.string().nullable().optional(),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Set this to N whenever the user named an explicit count -- "top 30", "last 30", "bottom 10", "highest 5", "worst 20" all mean limit: that number (30, 30, 10, 5, 20 respectively). Omit only when no count was named, to get the full POP list. If more than 500 is requested, only the top 500 are used for this analysis -- the full report shown to the user is not limited by this.'),
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
  });

  registerRankedTool(server, {
    name: 'get_package_financials',
    title: 'Get per-PACKAGE billed vs active customers',
    description:
      'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count together, one row per package (BandwidthName/package plan). Use this for any question that breaks billing, collections, refunds, adjustments, or active customers down by package/plan. Refunded/adjusted resolve via each customer\'s CURRENT package (dim_customer.package_id), not necessarily the package active on the refund/adjustment date.',
    cap: MAX_RANKED_LIMIT,
    service: getPackageFinancials,
    inputSchema: {
      dateFrom: z.string().nullable().optional(),
      dateTo: z.string().nullable().optional(),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Set to whatever count the user named ("top 10", "last 5", "bottom 3" -> 10, 5, 3). Omit for the full package list. If more than 500 is requested, only the top 500 are used for this analysis -- the full report shown to the user is not limited by this.'),
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
  });

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

  registerRankedTool(server, {
    name: 'get_ticket_type_breakdown',
    title: 'Get ticket volume AND avg resolution time by ticket type',
    description:
      'Real ticket COUNT and average resolution time TOGETHER, one row per ticket_type_id, with the real ticket_type_name joined in from dim_ticket_type where available (null if a type has no matching dimension row yet). Always call this for "what types of tickets" / "tickets by type" / "breakdown of ticket types" questions -- this breakdown IS available. If ticket_type_name is present, use the real name; if it is null for a row, report that row as "Type <id>" and say its name is not available yet. CRITICAL: avgResolutionHours will be null for every row -- no confirmed "ticket resolved" column exists in the source system yet. NEVER state a resolution-time number; if asked, say plainly it isn\'t available yet.',
    cap: MAX_RANKED_LIMIT,
    service: getTicketTypeBreakdown,
    inputSchema: {
      dateFrom: z.string().nullable().optional(),
      dateTo: z.string().nullable().optional(),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Set to whatever count the user named ("top 10", "last 5") -- see get_pop_financials\' limit for the full convention. Omit for every ticket type. If more than 500 is requested, only the top 500 are used for this analysis -- the full report shown to the user is not limited by this.'),
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
  });

  server.registerTool(
    'get_customer_financials',
    {
      title: 'Get per-CUSTOMER billed vs collected (top N by revenue)',
      description:
        'Total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), each customer\'s CURRENT package (packageId/packageName, from dim_customer.package_id -- this is the customer\'s present package, not a historical per-transaction package), and each customer\'s collected amount split by tran_mode_id (raw payment-channel code -- NOT yet resolved to a human name like "cash"/"bKash", no TranModeMaster reference table is synced yet), one row per customer, ranked and limited. Use this for a genuine "top N customers by revenue/billed/collected/outstanding/refunded/adjusted" question, "customer-level breakdown by transaction mode", or "top customers ... their package" -- i.e. whenever N is a realistic, specific count someone would actually read row by row. Do NOT use this for "every customer", "the whole customer base", "all 386,000 customers", or any count so large it is really asking about the ENTIRE population rather than a real top-N list -- use get_customer_financials_summary instead for those; this tool\'s own row cap would otherwise silently answer a whole-population question from a small, arbitrary slice. customer_id is a real direct column on fact_billing, fact_collection, fact_refund, AND fact_adjustment.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Set to whatever count the user named ("top 100" -> 100). Defaults to 100 if omitted. If more than 300 is requested, only the top 300 are used for this analysis -- the full report shown to the user is not limited by this.'),
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
        includeTranModeBreakdown: z
          .boolean()
          .nullable()
          .optional()
          .describe('Only set true if the user specifically asked to see each customer\'s collected amount split by transaction mode/payment channel. Leave false/omitted for an ordinary top-N-by-revenue question -- this breakdown roughly triples each row\'s size for no benefit when it wasn\'t asked for. The real report/table always includes it regardless of this flag; this only controls what is shown to you here for analysis.'),
      },
    },
    async ({ dateFrom, dateTo, limit, sortBy, direction, includeTranModeBreakdown }) => {
      const { effectiveLimit, note: capNote } = capLimitForLlm(limit, MAX_CUSTOMER_LIMIT);
      const result = await getCustomerFinancials({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: effectiveLimit,
        sortBy: sortBy || undefined,
        direction: direction || undefined,
      });

      // Strip the nested per-transaction-mode breakdown from what the LLM
      // sees unless it was actually asked for -- it's real data the user's
      // table/export always has, it's just unnecessary bulk here.
      const rowsForLlm = includeTranModeBreakdown
        ? result
        : result.map(({ collectedByTranMode, ...rest }) => rest);

      // When the request was capped, hand the model real aggregate totals
      // across ALL requested rows (not just the visible top N) so it can
      // still give an accurate "N customers, $X total outstanding" answer
      // instead of just describing the smaller visible slice.
      let note = capNote;
      if (capNote) {
        const sum = (key) => result.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
        const aggregate = {
          rowsShown: result.length,
          totals: {
            billed: sum('billed'),
            collected: sum('collected'),
            refunded: sum('refunded'),
            adjusted: sum('adjusted'),
            outstanding: sum('outstanding'),
          },
        };
        note = `${capNote} Aggregate totals across the shown top ${result.length} rows: ${JSON.stringify(aggregate.totals)}.`;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(withLlmNote(rowsForLlm, note)) }],
        structuredContent: { rows: rowsForLlm, note },
      };
    },
  );

  server.registerTool(
    'get_customer_financials_summary',
    {
      title: 'Get whole-customer-base financial summary (aggregate stats, not a row list)',
      description:
        'Aggregate statistics across the ENTIRE customer base (or the entire date-filtered slice of it) -- customer count, total/average/median billed, collected, and outstanding, the 90th-percentile outstanding balance, how many customers currently have a positive outstanding balance, and the real top-10 AND bottom-10 customers by outstanding. This does NOT return one row per customer -- it is the right tool whenever the question is really about the WHOLE population ("every customer", "all customers", "the whole customer base", "give me a report for every one of our 386,000 customers") rather than a specific top-N list (use get_customer_financials for a real top-N). Never estimate these numbers yourself from a smaller sample -- this tool computes them directly in the database across every matching row, so they are exact regardless of how many customers that is. A user who wants the actual full row-by-row list exported (not just insight) should be told the export happens separately (a server-generated file), since a row-by-row list of the whole customer base cannot be shown here or fit in this conversation.',
      inputSchema: {
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
      },
    },
    async ({ dateFrom, dateTo }) => {
      const result = await getCustomerFinancialsSummary({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerRankedTool(server, {
    name: 'get_ticket_pop_breakdown',
    title: 'Get ticket volume AND avg resolution time by POP',
    description:
      'Real ticket COUNT and average resolution time TOGETHER, one row per POP (resolved via each ticket\'s customer). Use this for "tickets by POP", "which POP has the most tickets", "support ticket breakdown by service area". CRITICAL: avgResolutionHours will be null for every row -- no confirmed "ticket resolved" column exists in the source system yet. NEVER state a resolution-time number; if asked, say plainly it isn\'t available yet.',
    cap: MAX_RANKED_LIMIT,
    service: getTicketPopBreakdown,
    inputSchema: {
      dateFrom: z.string().nullable().optional(),
      dateTo: z.string().nullable().optional(),
      limit: z.number().int().positive().nullable().optional().describe('Set to whatever count the user named. Omit to return every POP. If more than 500 is requested, only the top 500 are used for this analysis -- the full report shown to the user is not limited by this.'),
      sortBy: z.enum(['count', 'avgResolutionHours']).nullable().optional().describe('Default "count".'),
      direction: z.enum(['desc', 'asc']).nullable().optional().describe('"desc" (default) for most/highest; "asc" for least/lowest.'),
    },
  });

  registerRankedTool(server, {
    name: 'get_tran_mode_breakdown',
    title: 'Get total collected amount broken down by transaction mode',
    description:
      'Total COLLECTED amount (never billed -- a transaction mode is how money was actually received, so billed amounts have no mode) broken down by tran_mode_id, one row per mode, ranked and limited. Use this for "revenue/collected by transaction type", "which transaction mode brings the most revenue", "breakdown of collections by payment channel". tran_mode_id is the RAW payment-channel code, NOT yet resolved to a human name (no cash/bKash/Nagad label mapping is synced yet) -- report it as "Mode <id>", never invent what it means.',
    cap: MAX_RANKED_LIMIT,
    service: getTranModeBreakdown,
    inputSchema: {
      dateFrom: z.string().nullable().optional(),
      dateTo: z.string().nullable().optional(),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Set to whatever count the user named. Omit to return every transaction mode. If more than 500 is requested, only the top 500 are used for this analysis -- the full report shown to the user is not limited by this.'),
      direction: z
        .enum(['desc', 'asc'])
        .nullable()
        .optional()
        .describe('"desc" (default) for most/highest revenue; "asc" for least/lowest -- read the user\'s own word.'),
    },
  });

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
