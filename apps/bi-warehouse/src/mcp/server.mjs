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
import { getTicketMetrics, getTicketTypeBreakdown, getTicketPopBreakdown, getTicketList } from '../services/ticketService.mjs';
import { getCustomerSignups, getCustomerList } from '../services/customerService.mjs';
import { querySemanticLayerPage } from '../services/cubeQueryService.mjs';
import { METRICS } from '../semantic/metrics.mjs';
import { CUBE_CATALOG_TEXT } from '../semantic/cubeCatalog.mjs';

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
// FIX 2026-10-01: REAL, LIVE CRASH -- "all fiber tickets, complete info"
// called get_ticket_list with no limit, which (after today's fix raising
// the real data cap to 5,000 -- see getTicketList's own comment) returned
// up to 5,000 full ticket rows DIRECTLY into the draft/critique LLM calls'
// own context, no capLimitForLlm wrapper here unlike every other
// row/ranked tool in this file. Measured result: a single request asking
// for ~607,000 tokens against gpt-4o-mini's 200,000 TPM limit -- an
// instant, total request failure ("Could not process that request"), not
// a slow-down. get_ticket_list is fixed the same way get_customer_list
// already was: what the model itself sees is capped here; the real
// table/export the user sees still comes from the full, separately-capped
// (5,000-row) result via dashboardData() in bi-dashboard, untouched by
// this cap -- see capLimitForLlm's own comment for why this split exists.
const MAX_TICKET_LIST_LLM_LIMIT = 200;

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
- ticket_volume: from fact_ticket (TicketingDB.dbo.Tk_TicketInfoMaster,
  confirmed real source, not a placeholder). opened_date (creation time)
  is real and populated.
- avg_resolution_hours: will be null for every row -- no confirmed
  "ticket resolved" column exists on the source table yet (see
  src/etl/tables/tickets.mjs header comment). This is a genuine data gap,
  not a sync gap -- do not confuse this with ticket creation time, which
  is fully available.

## Valid dimensions per metric
${Object.entries(METRICS)
  .map(([name, m]) => `- ${name}: ${m.validDimensions.join(', ') || '(none)'}`)
  .join('\n')}
`;

// Hand-maintained to match cube/model/isp.yml exactly -- update this
// alongside any change to that file, since this is the ONLY place the
// agent learns which measure/dimension names are real.
const ISP_CUBE_CATALOG = CUBE_CATALOG_TEXT;

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
    'get_customer_signups',
    {
      title: 'Get customer signup/activation counts for a date range',
      description:
        'Count of customers whose entry_date (when they first signed up) or activated_date (when their service was activated) falls within a date range, from dim_customer. Always call this -- not get_active_customer_count -- for any question like "customers who joined/entered/signed up between X and Y", "how many customers from 2022 to 2024", "new customers last quarter", or "customer growth by month". Set groupBy to "month" for a trend over time, or to "pop_id"/"package_id"/"status_id" to break the count down by that dimension; omit groupBy for a single total. dateField picks which date column to filter on -- "entry" (signup date, the default) vs "activated" (service activation date); ask the user which they mean if genuinely ambiguous, but default to "entry" for a plain "customers from X to Y" question.',
      inputSchema: {
        dateField: z.enum(['entry', 'activated']).nullable().optional().describe('Which date column to filter/group on. Defaults to "entry" (signup date) if omitted.'),
        dateFrom: z.string().nullable().optional().describe('ISO date, e.g. "2022-01-01". Omit for no lower bound.'),
        dateTo: z.string().nullable().optional().describe('ISO date, e.g. "2024-12-31". Omit for no upper bound.'),
        groupBy: z.enum(['month', 'pop_id', 'package_id', 'status_id']).nullable().optional().describe('Omit for a single total count. "month" gives a trend over time; the others break the count down by that dimension.'),
        popId: z.string().nullable().optional().describe('Restrict to one POP id, e.g. for "customers from POP 3 who joined in 2023".'),
        packageId: z.string().nullable().optional(),
        statusId: z.string().nullable().optional(),
      },
    },
    async ({ dateField, dateFrom, dateTo, groupBy, popId, packageId, statusId }) => {
      const result = await getCustomerSignups({
        dateField: dateField || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        groupBy: groupBy || undefined,
        popId: popId || undefined,
        packageId: packageId || undefined,
        statusId: statusId || undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    'get_customer_list',
    {
      title: 'Get a row-level customer list for a date range',
      description:
        'Row-level list of customers (id, name, POP, package, status, entry_date, activated_date) within a date range, ranked by that date descending, up to a limit. Use this -- not get_customer_signups -- when the user wants to actually SEE the individual customers (names/ids), not just a count. For "every customer"/"the whole customer base" style questions where the count could be huge, prefer get_customer_signups with no limit concept, or get_customer_financials_summary for the full-population financial view -- this tool\'s row cap means it is only right for a genuinely small, specific list.',
      inputSchema: {
        dateField: z.enum(['entry', 'activated']).nullable().optional(),
        dateFrom: z.string().nullable().optional(),
        dateTo: z.string().nullable().optional(),
        popId: z.string().nullable().optional().describe('EITHER the raw pop_id OR the real POP name (e.g. "Mirpur") -- both are matched, no lookup needed first.'),
        packageId: z.string().nullable().optional().describe('EITHER the raw package_id OR the real package name -- both are matched.'),
        statusId: z.string().nullable().optional().describe('EITHER the raw status_id OR the real status name (e.g. "Active") -- both are matched.'),
        limit: z.number().int().positive().nullable().optional().describe('Omit this (or pass null) for "full"/"all" -- the underlying list returns up to the real cap of 5,000 rows AND the true total row count (totalCount), though what the model itself sees here is separately capped at 300 for context reasons (see the note field in the response) -- the real table/export the user sees is NOT limited by that 300 cap.'),
      },
    },
    async ({ dateField, dateFrom, dateTo, popId, packageId, statusId, limit }) => {
      const { effectiveLimit, note } = capLimitForLlm(limit, MAX_CUSTOMER_LIMIT);
      const result = await getCustomerList({
        dateField: dateField || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        popId: popId || undefined,
        packageId: packageId || undefined,
        statusId: statusId || undefined,
        limit: effectiveLimit,
      });
      // FIX 2026-10-01: getCustomerList now returns { rows, totalCount }
      // instead of a bare array (same fix as getTicketList, see that
      // function's own comment). SELF-CORRECTION same session: withLlmNote
      // returns the BARE ARRAY when note is null, so spreading it used to
      // silently produce a broken shape ({0: row, 1: row, ...,
      // totalCount} instead of {rows: [...], totalCount}) -- build the
      // object explicitly instead of relying on withLlmNote's dual shape.
      // 2026-10-04: the AI gets ONLY the DB-computed totals/summary, never
      // individual rows -- the user's table and Excel export come from the
      // database separately.
      void note;
      const payload = {
        totalCount: result.totalCount,
        summary: result.summary,
        note: `All figures are computed by the database over all ${result.totalCount.toLocaleString()} matching customers. The full list is shown to the user in the table (up to 5,000 rows) and Export Excel (all rows). Answer from these figures only; do not list individual customers.`,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'query_semantic_layer',
    {
      title: 'Query the ISP semantic layer (Cube) -- any measure, dimension, date range, or filter',
      description:
        `Generic query tool over the real ISP data warehouse's semantic layer (Cube), for any question the more specific named tools above don't already cover -- any date range, any dimension breakdown, any filter, on any of the cubes listed below. ALWAYS prefer a more specific tool above when one exists for the question (e.g. get_revenue_summary for billed/collected/outstanding, get_customer_signups for signup/activation date ranges) -- use this one when the question needs a measure/dimension/filter combination none of those cover.\n\nAvailable cubes, measures, and dimensions (the ONLY valid names -- Cube rejects anything else):\n${ISP_CUBE_CATALOG}\n\nFilters use Cube's own operator set: equals, notEquals, contains, notContains, gt, gte, lt, lte, set, notSet, inDateRange, beforeDate, afterDate. A date-range question should normally use timeDimensions (with dateRange: ["YYYY-MM-DD", "YYYY-MM-DD"]) rather than a filter, since timeDimensions also lets you ask for a granularity (e.g. "month") to get a trend over time in one call.\n\nLISTING INDIVIDUAL ROWS (not just a total): this works for EVERY cube, not only tickets/customers. A question like "show me each billing row for POP 24", "list the refunds for customer X", "which collections happened in March" wants real rows, not a count -- pass ONLY dimensions (no measures at all) plus your filters/timeDimensions and a limit, e.g. dimensions: ["IspBilling.billing_sk", "IspBilling.ref_date", "IspBilling.amount", "IspCustomer.customer_name", "IspPop.pop_name"], filters: [{member: "IspBilling.pop_id", operator: "equals", values: ["24"]}], limit: 200. Omitting "measures" entirely is what makes Cube return one row per record instead of an aggregate -- a query with measures present will always collapse to a summary, even with dimensions alongside it. Always set a limit on a row-listing query (200 is a reasonable default) since there is no automatic cap like the named tools have.`,
      inputSchema: {
        measures: z.array(z.string()).optional().describe('e.g. ["IspBilling.total_billed"]. Omit or use [] for individual records. At least one of measures or dimensions is required.'),
        dimensions: z.array(z.string()).nullable().optional().describe('e.g. ["IspCustomer.pop_id"] to break results down by POP.'),
        filters: z
          .array(
            z.object({
              member: z.string().describe('e.g. "IspCustomer.status_id"'),
              operator: z.enum([
                'equals', 'notEquals', 'contains', 'notContains',
                'gt', 'gte', 'lt', 'lte', 'set', 'notSet',
                'inDateRange', 'beforeDate', 'afterDate',
              ]),
              values: z.array(z.string()).nullable().optional().describe('Omit for set/notSet.'),
            }),
          )
          .nullable()
          .optional(),
        timeDimensions: z
          .array(
            z.object({
              dimension: z.string().describe('e.g. "IspCustomer.entry_date"'),
              dateRange: z.array(z.string()).length(2).nullable().optional().describe('["YYYY-MM-DD", "YYYY-MM-DD"]. Omit for all-time.'),
              granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable().optional().describe('Omit for a single total over the whole range; set this for a trend broken down over time.'),
            }),
          )
          .nullable()
          .optional(),
        limit: z.number().int().positive().nullable().optional().describe('Defaults to Cube\'s own default (10000) if omitted -- set a smaller number for a top-N style question.'),
        order: z
          .record(z.string(), z.enum(['asc', 'desc']))
          .nullable()
          .optional()
          .describe('e.g. {"IspBilling.total_billed": "desc"} to sort by a measure.'),
      },
    },
    async ({ measures, dimensions, filters, timeDimensions, limit, order }) => {
      // 2026-10-04: a row-listing query (dimensions only, no measures) never
      // hands individual rows to the model -- only the database's true row
      // count. The user's table/report/export re-run the query themselves.
      if (!measures || !measures.length) {
        const { rows, total } = await querySemanticLayerPage(
          { dimensions: dimensions || undefined, filters: filters || undefined, timeDimensions: timeDimensions || undefined, order: order || undefined },
          { offset: 0, limit: 5 },
        );
        const payload = {
          totalCount: total,
          records: total <= 5 ? rows : undefined,
          note: total <= 5 ? 'These are the matching records. Answer specific field/detail questions from them. Null means unavailable; preserve the exact record IDs.' : `This query matches ${total.toLocaleString()} rows, all computed by the database. The user sees them in the table and Export Excel; do not list individual rows. If the user wants totals or breakdowns, run an aggregate query with measures.`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
      const page = await querySemanticLayerPage({
        measures: measures || undefined,
        dimensions: dimensions || undefined,
        filters: filters || undefined,
        timeDimensions: timeDimensions || undefined,
        order: order || undefined,
      }, { limit: Math.min(limit || 50, 50), ...(limit ? { maxRows: limit } : {}) });
      const payload = { rows: page.rows, totalCount: page.total, partial: page.rows.length < page.total,
        note: page.rows.length < page.total ? 'These are preview groups, not the complete population. Query an ungrouped aggregate for global totals; never sum this preview as a population total.' : undefined };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'get_ticket_metrics',
    {
      title: 'Get ticket metrics',
      description:
        'AGGREGATE ticket volume and average resolution time only -- one count/average per group, never individual ticket rows (use get_ticket_list for that). When grouped by ticket_type_id, the real ticket_type_name is attached automatically. ' +
        'IMPORTANT, read carefully -- ticket CREATION time and ticket RESOLUTION time are two separate, different fields, do not conflate them: ' +
        'opened_date (ticket creation time) is a real, always-populated column -- if asked "is there a ticket creation time" or anything about when tickets were opened/created, the answer is YES, it is fully available, and dateFrom/dateTo here both filter on it. ' +
        'avgResolutionHours (ticket RESOLUTION time) will be null for every row -- no confirmed "ticket resolved" column exists in the real source system yet (the only candidate column, StatusChangeDate, has not been verified to actually mean "resolved"). If asked specifically about resolution/closing time, say plainly it is not available yet -- but NEVER let that affect the answer to a question about creation time, which is a completely different, fully-available field.',
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

  // NEW 2026-10-01: the row-level counterpart to get_ticket_metrics --
  // every ticket tool above this one could only ever answer with a
  // count/average. Use THIS tool whenever the question wants to actually
  // see tickets, not just a number about them.
  server.registerTool(
    'get_ticket_list',
    {
      title: 'List individual tickets (real rows, not a count)',
      description:
        'Individual ticket rows -- use this whenever the question asks to see, list, or show the actual tickets (e.g. "show me each ticket of type X", "list the tickets for department Y", "which tickets are still open") rather than just a total/average. get_ticket_metrics and get_ticket_type_breakdown only ever return aggregates; this is the one that returns real rows. Each row includes the real ticket_type_name (joined from dim_ticket_type). department_id is the RAW id only -- its human name is not resolved here, since the id-to-name mapping has not been independently verified yet (do not invent a department name). resolved_date will be null on every row -- no confirmed resolved-date column exists in the source system yet; opened_date (ticket creation time) is always real and populated.',
      inputSchema: {
        ticketTypeId: z.string().nullable().optional().describe('The ticket type to filter to -- EITHER the raw ticket_type_id code (e.g. from get_ticket_type_breakdown\'s results) OR the real type name exactly as the user said it (e.g. "Fiber Issue", "Bandwidth Slow") -- both are matched, you do not need to look up the id first.'),
        departmentId: z.string().nullable().optional().describe('Exact department_id (raw id, see note above).'),
        status: z.string().nullable().optional().describe('Exact status value to filter by, if the user named one.'),
        dateFrom: z.string().nullable().optional().describe('Filters on opened_date (creation time), ISO date.'),
        dateTo: z.string().nullable().optional().describe('Filters on opened_date (creation time), ISO date.'),
        limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('How many ticket rows to return, most recently opened first. Omit this (or pass null) for "full"/"all" -- it returns up to the real cap of 5,000 rows AND the true total row count (totalCount) so you can tell the user plainly when the result is capped, e.g. "showing 5,000 of 41,500". Never claim a capped result is the complete set.'),
      },
    },
    async ({ ticketTypeId, departmentId, status, dateFrom, dateTo, limit }) => {
      // FIX 2026-10-01: cap what the MODEL sees (MAX_TICKET_LIST_LLM_LIMIT)
      // -- same capLimitForLlm pattern get_customer_list already uses, see
      // that function's own comment for why this exists and why it does
      // NOT limit the real table/export the user sees.
      const { effectiveLimit, note } = capLimitForLlm(limit, MAX_TICKET_LIST_LLM_LIMIT);
      const result = await getTicketList({
        ticketTypeId: ticketTypeId || undefined,
        departmentId: departmentId || undefined,
        status: status || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: effectiveLimit,
      });
      // FIX 2026-10-01: getTicketList now returns { rows, totalCount }
      // instead of a bare array (see its own comment) specifically so a
      // capped "full" request can be reported honestly instead of
      // silently passed off as complete. structuredContent/text both
      // carry totalCount through so the model can say "showing X of Y".
      // FIX 2026-10-01 (self-correction, same session): withLlmNote
      // returns the BARE ARRAY when note is null (no cap applied) -- the
      // spread `{...withLlmNote(result.rows, note), totalCount}` used to
      // silently produce a broken shape in that case: array indices as
      // object keys ({0: row, 1: row, ..., totalCount}) instead of
      // {rows: [...], totalCount}. Build the object explicitly instead of
      // relying on withLlmNote's dual return shape here.
      // 2026-10-04: the model only sees a small sample; summary covers ALL
      // matching tickets, so the reply never reads "top 200 of 173,062".
      const listNote =
        `All figures are computed by the database over all ${result.totalCount.toLocaleString()} matching tickets. The full list is shown to the user in the table (up to 5,000 rows) and Export Excel (all rows). ` +
        'Answer from these figures only; do not list individual tickets or mention any row limit.';
      const payload = { totalCount: result.totalCount, summary: result.summary, note: listNote };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
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
