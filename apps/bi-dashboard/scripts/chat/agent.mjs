// The real chat brain: a LangGraph ReAct agent (via LangChain's ChatOpenAI),
// talking to the BI semantic layer through an actual MCP server.
//
// REWIRED: this used to talk to scripts/mcp/bi-mcp-server.mjs, a single
// flexible query_semantic_layer tool backed by the ecommerce MySQL demo
// data. It now talks to the real warehouse MCP server
// (apps/bi-warehouse/src/mcp/server.mjs's createWarehouseMcpServer()),
// which exposes FIXED, explicitly named tools only (get_revenue_summary,
// get_revenue_timeseries, get_region_breakdown, get_ticket_metrics) --
// there is no ad hoc "metric + groupBy" combination tool anymore, per the
// project's "no raw/ad hoc SQL construction by the LLM" requirement. All of
// the old prompt language and tool-call parsing logic built around that
// flexible tool (extraMetrics, customerSort, comparePreviousPeriod,
// metricBreakdown) has been removed accordingly -- the new server simply
// doesn't have anywhere to put those arguments.
//
// This replaces the old regex intent/topic classifier: the model itself
// decides when to call a tool and reasons over the real numbers it gets
// back, with conversation memory (recent turns) and scope guardrails in
// the system prompt, and a Zod-validated structured final answer so the
// rest of the app (chat UI, saved reports, "tables used" chips) keeps its
// existing contract.
import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { createWarehouseMcpServer } from '../../../bi-warehouse/src/mcp/server.mjs';
import { dashboardData, ALLOWED_TOPICS, tablesForTopic } from '../lib/dashboard-data.mjs';

// Real warehouse fact/dim tables, replacing the old ecommerce table list
// (orders/users/order_items/order_status_history).
const ALLOWED_TABLES = ['fact_billing', 'fact_collection', 'fact_refund', 'fact_adjustment', 'dim_customer', 'dim_package', 'fact_ticket'];

const ResponseSchema = z.object({
  intent: z
    .enum(['answer', 'create_new_page', 'ask_clarification'])
    .describe(
      // NOTE: whether this becomes a saved report/chart page is decided
      // separately by a dedicated report-intent gate (checkWantsReport), not
      // by this field -- this field only controls whether you should ask a
      // clarifying question instead of proceeding.
      'answer for a normal reply once you have (or determined you cannot get) a grounded answer; ask_clarification when the request is genuinely ambiguous or missing information you need to answer correctly -- in that case do NOT call a warehouse tool or guess a default, put your question to the user in narrative instead. create_new_page is accepted but ignored by the app -- always use answer or ask_clarification here.',
    ),
  topic: z
    .enum([...ALLOWED_TOPICS, 'dashboard'])
    .describe(
      'Which real breakdown this answer is grounded in -- set it to match whichever tool you actually called: get_pop_financials/get_region_breakdown -> "pops", get_package_financials -> "packages", get_revenue_timeseries_financials/get_revenue_timeseries -> "trend", get_ticket_type_breakdown/get_ticket_metrics -> "tickets", get_revenue_summary alone -> "billing", get_active_customer_count alone -> "customers", get_customer_financials -> "top_customers", get_tran_mode_breakdown -> "tran_modes", get_ticket_pop_breakdown -> "ticket_pops", get_tran_mode_by_dimension(dimension: "pop_id") -> "tran_mode_by_pop", get_tran_mode_by_dimension(dimension: "package_id") -> "tran_mode_by_package", no data lookup -> "dashboard". This decides which table renders alongside your narrative -- getting it wrong shows the wrong table under the right words, so match it to your actual tool call, never a guess.',
    ),
  title: z.string().describe('Short title for this reply, used as a report/page title when intent is create_new_page.'),
  narrative: z
    .string()
    .describe(
      // This same field is shown BOTH as the chat reply AND, verbatim, as
      // a saved report's "Insight Summary" (app/reports/[id]/page.tsx) --
      // whenever a table or chart is already rendering the actual rows, this
      // text must never become a second copy of that table in prose form.
      '2-4 sentences of STRUCTURED analysis, not a restated table. Sentence 1: the direct answer/headline finding (the specific number, name, or comparison actually asked for). Sentence 2: the single most notable pattern, stated using the REAL computed fields the tool already returned -- NEVER estimate or eyeball a percentage/concentration/rate yourself. get_pop_financials and get_package_financials rows each include collectionRate (collected/billed, already computed) and billedShare (this row\'s share of TOTAL billing across the FULL POP/package list, already computed against the complete set before any limit was applied -- use this directly for "X accounts for Y% of total billing", never estimate that percentage from the top-N subset alone). get_package_financials rows also include revenuePerActiveCustomer (billed/activeCustomers, already computed) -- use it for "package X generates $Y per active customer" framing, which is more meaningful than raw totals for comparing package value. If collectionRate is unusually low (e.g. under 50%) for the top row, that IS the notable pattern -- say so plainly (e.g. "POP 10 leads billing but its collection rate is only 34%, meaning most of that revenue hasn\'t actually been collected yet"). Optional sentence 3: brief context (vs. a prior period, vs. an average) only if genuinely relevant and the data supports it. NEVER list out individual row values/names one by one when a table or chart is already showing that breakdown -- summarize what the rows MEAN, don\'t re-narrate them. Uses ONLY values that came back from a warehouse tool call.',
    ),
  tablesUsed: z.array(z.enum(ALLOWED_TABLES)).describe('Only the real tables that genuinely back this answer.'),
  requestedMetrics: z
    .array(
      z.enum([
        'billed',
        'collected',
        'refunded',
        'adjusted',
        'outstanding',
        'activeCustomers',
        'count',
        'avgResolutionHours',
        'byTranMode',
        'packageName',
      ]),
    )
    .describe(
      // FIX 2026-09-17, GENERALIZED: this used to only cover
      // get_pop_financials -- but EVERY multi-column table
      // (get_pop_financials, get_package_financials,
      // get_customer_financials, get_revenue_timeseries_financials,
      // get_ticket_type_breakdown) had the same bug: it ALWAYS showed
      // every column the tool returns, even when the user named only
      // some of them (e.g. "total billed, total refunded, total adjusted,
      // plus outstanding" -- no "collected"; or "ticket count by type"
      // with no resolution time). Set this to EXACTLY the metrics the
      // user actually named in THIS message, whichever table topic
      // applies -- billed/collected/refunded/adjusted/outstanding for
      // billing-style breakdowns (pops/packages/top_customers/trend),
      // activeCustomers for packages, count/avgResolutionHours for
      // tickets, byTranMode for "collected by transaction mode" on
      // top_customers. Never the full set by default, and never omit one
      // they did name. If the user asked for a breakdown WITHOUT naming
      // specific metrics at all (e.g. "give me a report on POPs", "ticket
      // breakdown by type"), leave this empty and every available column
      // for that table will show -- the correct default for an unspecific
      // request.
      'Exactly which columns the user explicitly asked to see in a multi-column table this turn (billed/collected/refunded/adjusted/outstanding/activeCustomers/count/avgResolutionHours/byTranMode, whichever apply to the table topic) -- leave empty only when they did not name specific columns.',
    ),
});

const GUARDRAIL_SYSTEM_PROMPT = `You are the analytical engine behind a live BI dashboard chat for an ISP (internet service provider) billing/CRM/network-ops business -- a sharp, conversational senior business analyst, similar in tone to a helpful AI assistant, not a robotic report generator.

Scope: you help with THIS business's read-only billing, collections, customer, and support-ticket data -- total billed, total collected, outstanding balance, active customers, POP (service area) breakdowns, and ticket volume. You have no built-in knowledge of these numbers; the ONLY way to get real data is by calling one of these tools:
- get_revenue_summary(dateFrom?, dateTo?): total billed, total collected, outstanding balance (billed minus collected), total refunded, and total adjusted, for a date range, or all-time if omitted. Call this for any plain "how much have we billed/collected/how much is outstanding/how much have we refunded or adjusted" question.
- get_revenue_timeseries(metric: "total_billed" | "total_collected", dateFrom?, dateTo?): one row per day. Call this for trend/"over time"/"by day" questions.
- get_region_breakdown(metric: "total_billed" | "total_collected", dateFrom?, dateTo?): billed OR collected amount (never both) broken down by POP. Only use this for a single-metric POP question ("billing by POP"); for anything asking for more than one of billed/collected/outstanding per POP, use get_pop_financials instead.
- get_pop_financials(dateFrom?, dateTo?, limit?, sortBy?: "billed"|"collected"|"outstanding", direction?: "desc"|"asc"): total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count TOGETHER, one row per POP. ALWAYS use this -- never get_region_breakdown -- for a compound question like "billed vs collected per POP", "outstanding by POP", "refunded and adjusted by POP", "active customers per POP", or "detail for each POP". Set limit to whatever count the user named ("top 30" / "last 30" / "bottom 10" / "highest 5" / "worst 20" all mean limit: that number). Set direction from the user's own word: "desc" for top/highest/best/most, "asc" for last/bottom/lowest/worst/smallest -- read which one they actually said, never assume desc. Set sortBy to whichever column they named ("by outstanding", "by collected"); default billed. The tool sorts and limits for you -- never trim or reorder the result yourself. Each row ALSO includes collectionRate (collected/billed, already computed, null if billed is 0) and billedShare (this POP's billed amount as a fraction of TOTAL billed across ALL POPs, already computed against the full set before any limit was applied) -- use these two real fields for your analysis sentence, never estimate a percentage yourself.
- get_ticket_metrics(dateFrom?, dateTo?, groupBy?: "department_id" | "ticket_type_id"): ticket volume and average resolution time. CRITICAL -- avg_resolution_hours is NOT YET AVAILABLE (it will come back null/empty because no confirmed "ticket resolved" column exists in the source system yet). NEVER state a resolution-time number. If asked about resolution time, say plainly that it isn't available yet rather than inventing or estimating one.
- get_active_customer_count(): the real, current count of active customer accounts (status_id = 1 in dim_customer, point-in-time, not date-ranged). Call this for ANY question about how many active customers/subscribers/accounts exist. Never estimate, round, or recall this number from memory -- it MUST come from this tool.
- get_ticket_type_breakdown(dateFrom?, dateTo?, limit?, sortBy?: "count"|"avgResolutionHours", direction?: "desc"|"asc"): real ticket COUNT and average resolution time TOGETHER, one row per ticket_type_id, WITH the real ticket_type_name joined in where available. ALWAYS call this for "what types of tickets", "tickets by type", "breakdown of ticket types" questions -- this breakdown IS available, never say it isn't. Use the real ticketTypeName when present; for any row where it is null, report it as "Type <id>" and say that specific type's name isn't available yet -- never invent a name. avgResolutionHours will be null on every row (not available yet, see below) -- never state a resolution-time number. Set limit/sortBy/direction the same way as get_pop_financials -- read the user's own count and direction word, never assume desc.
- get_package_financials(dateFrom?, dateTo?, limit?, sortBy?: "billed"|"collected"|"outstanding"|"activeCustomers", direction?: "desc"|"asc"): total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), AND active customer count TOGETHER, one row per package/plan. Use for "billing by package", "billed vs collected by package", "active customers per package", "refunded and adjusted by package". Each row ALSO includes collectionRate, billedShare (same meaning as get_pop_financials, computed against the full package list), and revenuePerActiveCustomer (billed/activeCustomers, already computed, null if activeCustomers is 0) -- use revenuePerActiveCustomer to compare which packages are actually valuable per customer, not just which have the biggest raw total. NOTE: refunded/adjusted per package resolve via each customer's CURRENT package, not necessarily the package active on the date of that refund/adjustment -- real and useful, not historically exact.
- get_revenue_timeseries_financials(dateFrom?, dateTo?): billed, collected, refunded, AND adjusted TOGETHER, one row per day. Use this -- instead of get_revenue_timeseries -- for any trend question naming more than one of those four (e.g. "billed vs collected over time", "daily billed and refunded for the last 30 days").
- get_customer_financials(dateFrom?, dateTo?, limit?, sortBy?: "billed"|"collected"|"outstanding"|"refunded"|"adjusted", direction?: "desc"|"asc"): total billed, total collected, total refunded, total adjusted, outstanding (billed minus collected), each customer's CURRENT package (packageId/packageName -- their present package, not historical/per-transaction), AND each customer's collected amount split by tran_mode_id TOGETHER, one row per customer, ranked and limited (default 100). Use this for "top N customers by revenue/billed/collected", "customer breakdown by transaction mode", "refunded/adjusted by customer", or "top customers ... their package". Set requestedMetrics to include "packageName" whenever the user asks for package info per customer. NOTE: tran_mode_id is the RAW payment-channel code, not yet resolved to a human name (no cash/bKash/Nagad label mapping is synced yet) -- report it as "Mode <id>", never invent what it means.
- get_tran_mode_breakdown(dateFrom?, dateTo?, limit?, direction?: "desc"|"asc"): total COLLECTED amount (never billed -- a transaction mode is how money was actually received) broken down by tran_mode_id, one row per mode. Use this for "revenue/collected by transaction type", "which transaction mode brings the most revenue", "breakdown of collections by payment channel" -- a STANDALONE breakdown across the whole business, not tied to one customer (for a per-customer split, use get_customer_financials instead). Same NOTE as above: tran_mode_id is the RAW code, report it as "Mode <id>", never invent a name.
- get_tran_mode_by_dimension(dimension: "pop_id"|"package_id", dateFrom?, dateTo?): total COLLECTED amount broken down by BOTH transaction mode AND (POP or package) at once, one row per POP/package with its own mode breakdown inside it. Use this for "transaction mode by POP", "collections by payment channel per package", or any question crossing mode with POP/package specifically -- get_tran_mode_breakdown alone cannot do this (it only has one dimension). Same tran_mode_id RAW-code caveat applies.
- get_ticket_pop_breakdown(dateFrom?, dateTo?, limit?, sortBy?: "count"|"avgResolutionHours", direction?: "desc"|"asc"): real ticket COUNT and average resolution time TOGETHER, one row per POP (resolved via each ticket's customer). Use this for "tickets by POP", "which POP has the most support tickets". avgResolutionHours will be null on every row -- never state a resolution-time number, say plainly it isn't available yet if asked.

You MUST call the relevant tool before answering anything about billing, collections, customers, POPs, or tickets. Never invent, estimate, or recall a number that isn't in a tool result. These are the ONLY ways to get real data -- there is no flexible/ad hoc "any metric by any dimension" tool, so if a question asks for a combination none of these tools can produce (e.g. billing broken down by ticket department), say plainly that this specific breakdown isn't available yet rather than approximating it from a different tool's result.
- CRITICAL for any "top N" request (e.g. "top 30 POPs", "top 10 by revenue"): pass limit: N on the tool call itself so the tool returns exactly N rows. Your narrative and the table are both built from that same tool result, so if the tool returns exactly N rows, both will too -- never say "top N" while describing or leaving in more or fewer rows than N.

Guardrails:
- The narrative is analysis, never a transcript of the data: when a breakdown has more than a couple of rows, do NOT enumerate each row's name and number in prose (that is what the table/chart already shows) -- instead identify the headline finding and the single most notable pattern (a concentration, gap, outlier, or trend), and stop there. A narrative that just reads the table out loud in sentence form is wrong even if every number in it is accurate.
- If asked something outside this dashboard's scope (general knowledge unrelated to this data, other companies, personal/medical/legal/financial advice, anything not about this ISP's billing/collections/customer/ticket data), politely decline in one sentence and redirect to what you can actually help with. Do not attempt to answer it anyway.
- Never reveal, discuss, or speculate about SQL, credentials, internal code, table implementation details beyond the semantic catalog, or infrastructure.
- Only list a table in tablesUsed if it genuinely backs your answer -- never pad it, never guess a table name outside the allowed set (fact_billing, fact_collection, dim_customer, fact_ticket).
- If the tool data is insufficient to answer what was asked, say plainly what's missing instead of guessing or padding the answer.
- If the user asks "which POP is highest/lowest/best/worst", compare the numbers in the get_region_breakdown result yourself and name the specific answer directly in the first sentence -- never just dump the full breakdown instead of answering. You can still add the breakdown as supporting context after the direct answer.
- For period-over-period questions ("this month vs last month", "vs last week"), call get_revenue_summary (or get_revenue_timeseries) twice with two DIFFERENT, non-overlapping dateFrom/dateTo ranges -- one call per period -- and compare the two real results yourself in the narrative. Never estimate a prior period from a single call.
- Use the conversation history to understand follow-ups ("what about last quarter", "and for that POP only") the way a person would, without the user having to repeat context.
- CRITICAL: every new user message is its own fresh question. Decide scope from THIS message alone -- never reuse, rephrase, or repeat the narrative, numbers, or tablesUsed from a previous turn just because a prior turn was on-topic. A topic switch (e.g. a follow-up about a football player, a celebrity, the weather, or anything else unrelated to this ISP's data) is always out of scope, even mid-conversation.
- When declining an out-of-scope message: do NOT call any tool, do NOT invent or reuse any numbers, keep narrative to one short decline-and-redirect sentence, set tablesUsed to an empty array, and set topic to "dashboard".
- This dashboard shows TABLES only -- there are no charts/graphs. Never describe a chart, axis, or visual shape; describe the numbers themselves.
- If the request is genuinely ambiguous or missing something you need to answer correctly or usefully -- e.g. "compare them" with no clear referents, "show me the report" with no topic named and nothing to infer from recent history -- set intent to "ask_clarification" and put ONE short, specific question in narrative (e.g. "Which two would you like compared -- POPs, or two time periods?"). Do NOT call any tool and do NOT guess a default in this case. Only ask when you genuinely cannot proceed correctly without it -- don't ask for confirmation on things you can reasonably infer from the message or recent conversation (a bare "generate a graph" right after a data answer is NOT ambiguous, it clearly means chart that data).
- CRITICAL -- answering your OWN prior clarifying question: if the most recent ASSISTANT message in the history you're shown was itself a clarifying question (it asked the user to specify a metric, dimension, count, or similar), treat the user's CURRENT message as their answer to that exact question, even if it's terse, typo-heavy, or only partially resembles your phrasing (e.g. you asked "billed, collected, outstanding, or active customers?" and they reply "active customers top 15 packages and billed amounts collected amount" -- that names active customers, billed, and collected: proceed with a real tool call using those, do NOT ask the same or a rephrased version of the same question again). Only ask a SECOND clarifying question in a row if their reply is itself still genuinely unusable (e.g. they replied with something unrelated entirely). Silently correct obvious typos in their reply rather than treating them as ambiguity.

Example -- out-of-scope follow-up:
User: "which POP has the lowest billing?"
Assistant: (calls get_region_breakdown, answers with real numbers, tablesUsed: ["fact_billing"])
User: "can you tell me about messi?"
Assistant: narrative: "I'm focused on this business's billing and ticket data, so I can't help with that -- ask me about billing, collections, POPs, or tickets instead." tablesUsed: [] topic: "dashboard" intent: "answer"`;

const ScopeSchema = z.object({
  inScope: z
    .boolean()
    .describe(
      'true only if this message is asking about, or is a natural continuation of asking about, THIS ISP business\'s own read-only billing/collections/customer/ticket data: total billed, total collected, outstanding balance, active customers, POPs (service areas), or support tickets. false for anything else -- other companies, public figures, celebrities, athletes, general knowledge, personal/medical/legal/financial advice, small talk unrelated to the data, or requests about SQL/credentials/infrastructure.',
    ),
  declineReason: z
    .string()
    .describe('If inScope is false, ONE short, friendly sentence declining and redirecting to what you can help with (billing, collections, customers, POPs, tickets). Empty string if inScope is true.'),
  isGreetingOrMeta: z
    .boolean()
    .describe(
      'true if this message is a greeting ("hi", "hello", "hey"), simple thanks/acknowledgement, or a meta question about the chatbot itself ("what can you help with", "what do you do", "how does this work") -- i.e. it needs NO real data lookup at all, just a capabilities reply. false for anything that is actually asking about billing/collections/customers/POPs/tickets data, even loosely. Only meaningful when inScope is true.',
    ),
});

const SCOPE_GATE_PROMPT = `You are a strict scope classifier gate in front of a BI dashboard chatbot. The chatbot answers two kinds of things:
(a) questions about ONE ISP business's own read-only data: total billed, total collected, outstanding balance, active customers, POPs (service areas), support tickets;
(b) meta questions about the chatbot/dashboard itself and what it can do -- e.g. "what can you help with", "db info", "database info", "what data do you have", "what tables do you have access to", "how does this work", greetings like "hi"/"hello", or simple thanks/acknowledgements. These are IN SCOPE too, even though they are not themselves a data query -- the chatbot answers them by describing its own capabilities and the general shape of the data (never raw SQL or credentials).

You will be shown a short excerpt of the recent conversation for context, then the current user message to classify. Use that history ONLY to judge topic continuity -- does the current message plausibly continue the same in-scope conversation (e.g. "generate graph" or "show that as a chart" right after a data answer, "what about last quarter", "and for Europe?"), or does it clearly switch to something unrelated (an athlete, celebrity, other company, general trivia)? You are not writing an answer and must not reuse any numbers from the history -- you are only deciding in-scope vs out-of-scope for the CURRENT message.

IN SCOPE: (a) and (b) above, plus any message that is a plausible continuation of the recent in-scope conversation -- including short action requests like "generate graph", "show it as a chart", "make that a report", "export it" that refer back to data just discussed.
OUT OF SCOPE: a message that clearly introduces something unrelated to this store's data or this chatbot -- an athlete, celebrity, other company, general trivia/knowledge, personal/medical/legal/financial advice -- even if it follows an in-scope message.

When in doubt about a bare, ambiguous, or short message, ask: given the recent conversation, could this plausibly be continuing this store's data conversation or the chatbot itself? If yes, IN SCOPE. Only mark OUT OF SCOPE when the message clearly names or asks about something unrelated.

Set isGreetingOrMeta to true for category (b) above (greetings, thanks, "what can you help with" style questions) -- these get a fixed capabilities reply with no data lookup. Set it to false for category (a) (an actual data question, even a vague or short one) and false whenever inScope is false.`;

let cachedScopeModel = null;

function getScopeModel() {
  if (cachedScopeModel) return cachedScopeModel;
  cachedScopeModel = new ChatOpenAI({
    model: process.env.OPENAI_SCOPE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  }).withStructuredOutput(ScopeSchema);
  return cachedScopeModel;
}

async function checkScope(message, history = []) {
  const scopeModel = getScopeModel();
  const recentTurns = history.slice(-4);
  const historyText = recentTurns.length
    ? recentTurns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 300)}`).join('\n')
    : '(no prior messages in this conversation)';
  const result = await scopeModel.invoke([
    new SystemMessage(SCOPE_GATE_PROMPT),
    new HumanMessage(`Recent conversation (context only -- do not reuse any numbers from it):\n${historyText}\n\nCurrent user message to classify: ${JSON.stringify(message)}`),
  ]);
  console.log('[agent] scope gate result:', JSON.stringify(result));
  return result;
}


// The scope gate's isGreetingOrMeta field is a SINGLE LLM judgment, and a
// single classifier call deciding "does this need real data at all" is the
// one place in this pipeline where a wrong answer skips the tool-calling
// agent entirely and returns a canned reply with zero recovery (unlike the
// draft answer, which gets a critique/retry pass -- see critiqueNode below).
// A live bug (a plain, in-scope data question like "need total revenue for
// each customer" being misclassified as a greeting/meta message, so it got
// the fixed "Hey! I can help with..." reply instead of ever running a
// query) showed that trusting that one field alone isn't safe enough for a
// decision this consequential. Rather than patch the scope-gate prompt with
// more examples (that only helps the specific wording that happened to be
// reported), this asks a second, independently-framed question -- not
// "is this a greeting", but "would answering this well require looking at
// the store's actual data" -- and the two must agree before the greeting
// short-circuit is allowed to fire. See decideEntryRoute, which is the
// actual (pure, unit-tested) decision logic that combines them.
const NeedsDataSchema = z.object({
  needsDataLookup: z
    .boolean()
    .describe(
      'true if answering this message well requires looking up a real number, count, date, or record from this ISP\'s data (billing, collections, outstanding balance, customers, POPs, or tickets) -- even a vague, short, or typo-ridden data question still counts as true. false only if the message could be fully and honestly answered with no data lookup at all -- a greeting, thanks, or a question about the chatbot/dashboard itself and what it can do.',
    ),
});

const NEEDS_DATA_PROMPT = `You classify a single user message for a BI dashboard chatbot. Decide ONLY this: to answer this message well, does the chatbot need to look up real data from this ISP business (billing, collections, outstanding balance, customers, POPs, tickets)?

true: any question, however short, vague, or typo-ridden, that is asking about this business's actual numbers or records -- "billing by POP", "how much have we collected this month", "top POPs", "how many tickets last week", "which POP is lowest".
false: a greeting ("hi", "hello"), thanks/acknowledgement, or a question about the chatbot/dashboard itself and what it can do ("what can you help with", "how does this work", "what data do you have") -- none of these need a data lookup to answer.

Focus only on whether a data lookup is genuinely needed -- ignore spelling, grammar, and phrasing quality entirely.`;

let cachedNeedsDataModel = null;

function getNeedsDataModel() {
  if (cachedNeedsDataModel) return cachedNeedsDataModel;
  cachedNeedsDataModel = new ChatOpenAI({
    model: process.env.OPENAI_SCOPE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  }).withStructuredOutput(NeedsDataSchema);
  return cachedNeedsDataModel;
}

async function checkNeedsDataLookup(message, history = []) {
  const needsDataModel = getNeedsDataModel();
  const recentTurns = history.slice(-4);
  const historyText = recentTurns.length
    ? recentTurns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 300)}`).join('\n')
    : '(no prior messages in this conversation)';
  const result = await needsDataModel.invoke([
    new SystemMessage(NEEDS_DATA_PROMPT),
    new HumanMessage(`Recent conversation (context only):\n${historyText}\n\nCurrent user message to classify: ${JSON.stringify(message)}`),
  ]);
  console.log('[agent] needs-data gate result:', JSON.stringify(result));
  return result;
}

// Pure decision logic, deliberately separated from the three LLM calls that
// feed it so it can be unit-tested against a full matrix of
// (scope, wantsReport, needsData) combinations -- including the exact
// combination that produced the live bug above -- without needing network
// access to actually invoke OpenAI. This is the ONLY place that decides
// which of the three fixed early-return shapes (out-of-scope decline,
// greeting/meta, or "run the real agent") applies.
export function decideEntryRoute({ scope, needsData }) {
  // Same corroboration principle as the greeting branch below, applied to
  // the OTHER consequential decision this gate makes. A live bug ("can i
  // get order status" and "order status report" -- both squarely in scope,
  // "status" is a real supported dimension -- both getting declined as
  // out-of-scope) showed the scope gate's inScope=false verdict was being
  // trusted alone, with zero recovery, exactly like the greeting
  // misclassification fixed earlier. If the independent needs-data gate
  // thinks this message genuinely needs a real store-data lookup, that's
  // strong evidence it is NOT actually off-topic, so don't decline it on
  // the scope gate's word alone.
  if (!scope.inScope && !needsData.needsDataLookup) {
    return { route: 'out_of_scope' };
  }
  // Only short-circuit to the canned greeting/meta reply when BOTH
  // independent classifiers agree no data lookup is needed. If either one
  // thinks this message needs real data, it goes to the real agent instead
  // -- a false positive here just costs one extra (correct) tool call; a
  // false negative used to mean a real data question got a non-answer with
  // no recovery at all.
  if (scope.isGreetingOrMeta && !needsData.needsDataLookup) {
    return { route: 'greeting' };
  }
  return { route: 'agent' };
}

const ReportGateSchema = z.object({
  wantsReport: z
    .boolean()
    .describe(
      'true if the user is asking to SEE this data as a report, chart, graph, visualization, or dashboard view -- in any phrasing ("generate a report", "I need a report for X", "can I get a chart of X", "show that as a graph", "give me a dashboard for X"). false if they are just asking a plain question and expect a spoken/text answer, with no report or visual deliverable implied.',
    ),
});

const REPORT_GATE_PROMPT = `You are a strict classifier gate in front of a BI dashboard chatbot. The chatbot can respond two ways: a plain conversational text answer, or a full report/chart page (a saved report with a visualization attached).

Decide ONLY this: does the user want the second kind -- a report, chart, graph, dashboard, or visualization -- rather than just a text answer?

This is a request for a report/chart regardless of how it's phrased -- imperative ("generate", "build", "show me", "visualize") and non-imperative ("I need a report for X", "I want a chart of X", "give me a report on X", "can I get a graph of X", "do you have a dashboard for X") both count equally. The user naming the deliverable (report/chart/graph/dashboard/visualization) at all, in any phrasing, means true.

If the user is just asking a direct factual question ("what was revenue last month", "which region is lowest") with no mention of seeing it as a report/chart/graph, that is false -- they want a spoken answer, not a page.

Use the recent conversation only to resolve short follow-ups like "show that as a chart" or "now as a graph" referring back to data just discussed -- those are also true.`;

let cachedReportGateModel = null;

function getReportGateModel() {
  if (cachedReportGateModel) return cachedReportGateModel;
  cachedReportGateModel = new ChatOpenAI({
    model: process.env.OPENAI_SCOPE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  }).withStructuredOutput(ReportGateSchema);
  return cachedReportGateModel;
}

async function checkWantsReport(message, history = []) {
  const gateModel = getReportGateModel();
  const recentTurns = history.slice(-4);
  const historyText = recentTurns.length
    ? recentTurns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 300)}`).join('\n')
    : '(no prior messages in this conversation)';
  const result = await gateModel.invoke([
    new SystemMessage(REPORT_GATE_PROMPT),
    new HumanMessage(`Recent conversation (context only):\n${historyText}\n\nCurrent user message to classify: ${JSON.stringify(message)}`),
  ]);
  console.log('[agent] report gate result:', JSON.stringify(result));
  return result;
}

const CritiqueSchema = z.object({
  grounded: z
    .boolean()
    .describe(
      'true if every specific number, date, or figure stated in the narrative actually appears in the provided tool results (minor rounding/formatting differences are fine). false if the narrative states ANY number, date, or figure that cannot be found in the tool results -- including a number from a different breakdown than the one actually queried.',
    ),
  issues: z
    .array(z.string())
    .describe('If grounded is false, one short entry per unverifiable claim, quoting the specific number/figure and what is wrong with it. Empty array if grounded is true.'),
});

const CRITIQUE_PROMPT = `You are a strict fact-checker sitting between a BI chatbot and the user. You will be shown the raw tool result data the chatbot actually queried, and the narrative it drafted in response. Your only job: does every specific number, date, or figure in the narrative genuinely appear in the tool results, attached to the SAME entity/row it's reported against? A number that is real but attached to the wrong entity (e.g. a customer's real order count from one breakdown mistakenly reported next to a different breakdown's revenue figure for that same customer, or vice versa) is NOT grounded -- flag it just like an invented number. Also flag anything invented, hallucinated, stale from a previous turn, pulled from a different breakdown than the one shown, or a vague hedge like "an unspecified number" standing in for a real figure the data actually has.

The following are explicitly NOT grounding violations -- never flag them, they waste a redraft cycle for no reason: a thousands separator (20427.01 in the tool result written as $20,427.01 in the narrative is the SAME number); rounding to whole dollars, one decimal, or a "$1.2K"/"$45.7K" compact form of the same underlying value (1682.4966 shown as $1,682 or $1.68K is the SAME number -- check by rounding, not by exact string match); and a total/sum the narrative computed by adding several tool-result rows together, AS LONG AS that arithmetic is actually correct. Only flag a number if it genuinely refers to a different quantity than what the tool returned, not because its formatting or rounding differs from the tool's raw representation.`;

let cachedCritiqueModel = null;

function getCritiqueModel() {
  if (cachedCritiqueModel) return cachedCritiqueModel;
  cachedCritiqueModel = new ChatOpenAI({
    model: process.env.OPENAI_SCOPE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  }).withStructuredOutput(CritiqueSchema);
  return cachedCritiqueModel;
}

const MAX_DRAFT_RETRIES = 1;

// A real LangGraph StateGraph (not just the prebuilt ReAct wrapper): the
// agent's draft is fact-checked against its OWN tool results before it's
// ever returned, and gets one chance to redraft if the check fails. This
// catches ungrounded/mismatched narratives (e.g. citing a number from a
// breakdown that wasn't actually the one charted) at the source, instead of
// relying on someone spotting it later and patching that one case by hand.
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  toolOutputs: Annotation({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  lastAgentMessages: Annotation({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  structured: Annotation({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  critique: Annotation({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  retries: Annotation({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
});

// The agent can call the SAME warehouse tool more than once in a single
// turn -- most commonly a draft/critique retry re-running the same tool
// with corrected date args, or two genuinely different date ranges for a
// period-over-period question (see the guardrail prompt). For the plain
// single-range tools (get_revenue_summary, get_region_breakdown,
// get_ticket_metrics) only the LAST call's result is treated as ground
// truth, mirroring the old "last call wins" rule (now keyed on tool NAME
// instead of the old flexible tool's groupBy argument, since each of the
// four new tools already answers one fixed kind of question). For
// get_revenue_timeseries specifically, two DIFFERENT date ranges are a
// deliberate period-over-period comparison (per the guardrail prompt) and
// both are real, intentional calls -- so BOTH survive here, keyed by their
// actual date range, rather than the second one silently discarding the
// first.
export function extractWinningToolOutputs(messages) {
  const callInfoById = new Map();
  for (const m of messages) {
    const calls = m?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call?.id) callInfoById.set(call.id, { name: call.name, args: call.args ?? {} });
    }
  }

  const winningByKey = new Map();
  for (const m of messages) {
    if (m?.getType?.() !== 'tool') continue;
    const info = callInfoById.get(m.tool_call_id);
    const content = String(m.content).slice(0, 4000);
    const toolName = info?.name;
    const key =
      toolName === 'get_revenue_summary' || toolName === 'get_revenue_timeseries'
        ? `${toolName}:${info?.args?.dateFrom ?? ''}:${info?.args?.dateTo ?? ''}:${info?.args?.metric ?? ''}`
        : toolName ?? `unknown:${m.tool_call_id}`;
    // Overwrite, never append, for a repeated identical key -- only the
    // most recent identical call should be treated as ground truth. Two
    // calls to the same tool with genuinely different args (different date
    // range, different metric) get different keys and both survive.
    winningByKey.set(key, content);
  }
  return [...winningByKey.values()];
}

function formatPct(ratio) {
  return ratio === null || ratio === undefined ? 'not computable' : `${(ratio * 100).toFixed(2)}%`;
}

function formatMoney(amount) {
  return amount === null || amount === undefined
    ? 'N/A'
    : `$${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// Deterministic (code-computed, never LLM-authored) insight sentence --
// see FIX 2026-09-17 comment at the call site for why this exists.
function buildDeterministicInsight(topic, data) {
  if (topic === 'pops' && Array.isArray(data?.popFinancials) && data.popFinancials.length) {
    const top = [...data.popFinancials].sort((a, b) => b.billed - a.billed)[0];
    if (top) {
      return `Concretely: POP ${top.pop} is the single largest biller, accounting for ${formatPct(top.billedShare)} of total billing across all POPs shown, with a collection rate of ${formatPct(top.collectionRate)}.`;
    }
  }
  if (topic === 'packages' && Array.isArray(data?.packageFinancials) && data.packageFinancials.length) {
    const top = [...data.packageFinancials].sort((a, b) => b.billed - a.billed)[0];
    if (top) {
      const name = top.packageName ?? `Package ${top.packageId ?? 'Unknown'}`;
      return `Concretely: ${name} is the top-billing package, accounting for ${formatPct(top.billedShare)} of total billing, with a collection rate of ${formatPct(top.collectionRate)} and ${formatMoney(top.revenuePerActiveCustomer)} revenue per active customer.`;
    }
  }
  return null;
}

async function draftNode(state) {
  const tools = await getAgentTools();
  // FIX 2026-09-17: was temperature 0.2 -- every gate classifier in this
  // file (scope/needs-data/report-gate/critique) already uses temperature 0
  // for determinism, but this draft model (the one that actually writes the
  // narrative shown to the user) did not. Confirmed real bug via live
  // testing: asking the EXACT same question twice against the SAME
  // warehouse data returned two narratives that highlighted different POPs
  // as "notable" -- the underlying numbers were identical both times
  // (verified: POP 67 outstanding was -$84,870.28 in both runs), only the
  // model's free choice of what to emphasize varied. For a business report,
  // the same question against unchanged data must produce the same answer.
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  });
  const agent = createReactAgent({ llm: model, tools, responseFormat: ResponseSchema });
  const result = await agent.invoke({ messages: state.messages });
  const resultMessages = result.messages ?? [];
  const toolOutputs = extractWinningToolOutputs(resultMessages);
  return {
    structured: result.structuredResponse,
    toolOutputs,
    lastAgentMessages: resultMessages,
  };
}

async function critiqueNode(state) {
  if (!state.structured?.narrative) {
    return { critique: { grounded: true, issues: [] } };
  }
  const critiqueModel = getCritiqueModel();
  const toolResultsText = state.toolOutputs.length ? state.toolOutputs.join('\n---\n') : '(no tool was called)';
  const result = await critiqueModel.invoke([
    new SystemMessage(CRITIQUE_PROMPT),
    new HumanMessage(`Tool results:\n${toolResultsText}\n\nNarrative to check:\n${state.structured.narrative}`),
  ]);
  console.log('[agent] critique result:', JSON.stringify(result));

  if (result.grounded === false) {
    const nextRetries = state.retries + 1;
    if (nextRetries <= MAX_DRAFT_RETRIES) {
      const feedback = new SystemMessage(
        `Your previous answer contained figures that could not be verified against the real tool results: ${result.issues.join('; ')}. Re-check the actual data (call the relevant warehouse tool again if needed) and rewrite your narrative using ONLY numbers that genuinely appear there.`,
      );
      return { critique: result, retries: nextRetries, messages: [feedback] };
    }
    return { critique: result, retries: nextRetries };
  }
  return { critique: result };
}

function routeAfterCritique(state) {
  if (state.critique?.grounded !== false) return 'done';
  if (state.retries > MAX_DRAFT_RETRIES) return 'done';
  return 'retry';
}

let cachedBiGraph = null;

function getBiGraph() {
  if (cachedBiGraph) return cachedBiGraph;
  cachedBiGraph = new StateGraph(GraphState)
    .addNode('draft', draftNode)
    .addNode('critiqueCheck', critiqueNode)
    .addEdge(START, 'draft')
    .addEdge('draft', 'critiqueCheck')
    .addConditionalEdges('critiqueCheck', routeAfterCritique, { retry: 'draft', done: END })
    .compile();
  return cachedBiGraph;
}

let cachedTools = null;

async function getAgentTools() {
  if (cachedTools) return cachedTools;
  // In-process MCP connection via InMemoryTransport, same integration style
  // the old bi-mcp-server.mjs used -- this is a straight swap of WHICH
  // server backs the connection (real warehouse tools instead of the old
  // ecommerce ones), not a change to how the agent talks to MCP.
  const server = createWarehouseMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bi-dashboard-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cachedTools = await loadMcpTools('bi-warehouse-semantic-layer', client);
  return cachedTools;
}

// Deterministic, not another LLM call -- "top N" is an exact literal
// instruction, not something that needs judgment. Parsed once here and
// threaded straight through to dashboardData()'s row limit, so the table
// the user sees is guaranteed to have exactly N rows whenever they asked
// for an explicit count, instead of relying on the model to both notice
// the number AND remember to pass it as a tool argument every time.
export function extractExplicitLimit(message) {
  const match = String(message).match(/\btop\s+(\d{1,4})\b/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function runBiAgent({ message, history = [], pageState = {} }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  console.log('[agent] runBiAgent starting, checking scope, report intent, and data need...');
  // Run independently of each other -- three small, single-purpose,
  // temperature-0 classifiers, instead of one big call asked to write the
  // answer AND decide page-vs-text AND stay in scope AND judge whether data
  // is needed all at once. checkNeedsDataLookup is a deliberately
  // independent second opinion on scope.isGreetingOrMeta -- see
  // decideEntryRoute and the comment above it for why.
  const [scope, wantsReport, needsData] = await Promise.all([
    checkScope(message, history),
    checkWantsReport(message, history),
    checkNeedsDataLookup(message, history),
  ]);
  const { route } = decideEntryRoute({ scope, needsData });

  if (route === 'out_of_scope') {
    console.log('[agent] scope gate declined -- short-circuiting before the agent/tools run.');
    return {
      intent: 'answer',
      topic: 'dashboard',
      title: 'Out of Scope',
      narrative:
        scope.declineReason && scope.declineReason.trim()
          ? scope.declineReason.trim()
          : "I'm focused on this business's billing and ticket data, so I can't help with that -- ask me about billing, collections, customers, POPs, or tickets instead.",
      filters: { days: Number(pageState.days ?? 30), region: pageState.region ?? null },
      tablesUsed: [],
      data: null,
    };
  }

  if (route === 'greeting') {
    // Deterministic short-circuit, not another prompt instruction: a
    // greeting/meta message never reaches the tool-calling agent at all, so
    // there is no path left for it to "decide" to fetch a number to show
    // off with. Fixed reply, zero LLM narrative risk on this branch. Only
    // reached when BOTH the scope gate and the independent needs-data gate
    // agree no data lookup is needed -- see decideEntryRoute.
    console.log('[agent] greeting/meta message -- short-circuiting before the agent/tools run.');
    return {
      intent: 'answer',
      topic: 'dashboard',
      title: 'Hello',
      narrative:
        "Hey! I can help with billing, collections, outstanding balance, active customers, POPs, or support tickets -- what would you like to know?",
      filters: { days: Number(pageState.days ?? 30), region: pageState.region ?? null },
      tablesUsed: [],
      data: null,
    };
  }

  console.log('[agent] scope gate passed, loading MCP tools...');
  const tools = await getAgentTools();
  console.log(`[agent] MCP tools loaded: ${tools.map((t) => t.name).join(', ')}`);

  const historyMessages = history
    .slice(-12)
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));

  const contextNote = `Current page state: days=${pageState.days ?? 30}, region=${pageState.region ?? 'null'}, availableRegions=${JSON.stringify(pageState.availableRegions ?? [])}.`;

  console.log('[agent] invoking draft -> critique graph...');
  const graphResult = await getBiGraph().invoke({
    messages: [
      new SystemMessage(`${GUARDRAIL_SYSTEM_PROMPT}\n\n${contextNote}`),
      ...historyMessages,
      new HumanMessage(message),
    ],
  });
  console.log(
    '[agent] graph completed. redraft attempts:', graphResult.retries,
    'final grounded:', graphResult.critique?.grounded,
    'message count:', graphResult.lastAgentMessages?.length,
  );

  const structured = graphResult.structured;
  const agentMessages = graphResult.lastAgentMessages ?? [];
  console.log('[agent] structuredResponse:', JSON.stringify(structured));

  // Recover the (days, region) the agent actually queried with, from its own
  // tool call, so we can pull the FULL chart-ready dataset (not just the
  // trimmed JSON handed to the model) for report/artifact rendering.
  //
  // The old ecommerce tool took a `days` window + region filter directly;
  // the new warehouse tools take dateFrom/dateTo instead (or nothing, for
  // all-time), and none of them take a region/POP filter (get_region_breakdown
  // always returns every POP). `days` is recovered here by measuring the
  // span of the LAST dateFrom/dateTo pair any warehouse tool was actually
  // called with, so the dashboard's day-window chart stays in sync with
  // whatever range the agent just reasoned over; region stays whatever the
  // page state already had (there is no tool argument to change it from).
  let usedArgs = { days: Number(pageState.days ?? 30), region: pageState.region ?? null };
  // Recovered from the model's OWN real get_pop_financials call, the same
  // way `days` is recovered above from its own dateFrom/dateTo -- not
  // guessed from the user's raw text with a regex. A regex can only ever
  // catch the literal words it was written for (e.g. "top N"); it has no
  // way to know "last 30", "bottom 10", or "lowest 5 by outstanding" name
  // the same shape of request with a different direction/column. The model
  // already reads English natively and sets these as real structured tool
  // arguments (see server.mjs's get_pop_financials schema) -- this just
  // reads back what it actually decided, so the saved report/table uses
  // the exact same row count, sort column, and direction the model itself
  // reasoned about, guaranteed to match instead of independently re-guessed.
  let popFinancialsArgs = null;
  let calledAnyTool = false;
  for (const msg of agentMessages) {
    const calls = msg?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!['get_revenue_summary', 'get_revenue_timeseries', 'get_revenue_timeseries_financials', 'get_region_breakdown', 'get_pop_financials', 'get_package_financials', 'get_ticket_metrics', 'get_active_customer_count', 'get_ticket_type_breakdown', 'get_customer_financials', 'get_tran_mode_breakdown', 'get_ticket_pop_breakdown', 'get_tran_mode_by_dimension'].includes(call.name)) {
        continue;
      }
      calledAnyTool = true;
      const { dateFrom, dateTo, limit, sortBy, direction } = call.args ?? {};
      if (dateFrom && dateTo) {
        const spanDays = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86_400_000) + 1;
        if (Number.isFinite(spanDays) && spanDays > 0) {
          usedArgs = { ...usedArgs, days: spanDays };
        }
      }
      if (call.name === 'get_pop_financials') {
        popFinancialsArgs = { limit: limit || undefined, sortBy: sortBy || undefined, direction: direction || undefined };
      }
    }
  }

  // FIX 2026-09-17: tablesUsed used to be a field the draft LLM filled in
  // itself (a free judgment call, like the narrative's wording), and live
  // testing proved it: the EXACT same question, against the EXACT same
  // warehouse data, self-reported ["fact_billing"] on one run and
  // ["fact_billing", "fact_collection"] on the next -- even though
  // getPopFinancials() always queries both tables every time, no matter
  // what the model says. This is not the model's call to make; it's a
  // deterministic fact of which tables the topic's real breakdown function
  // queries (see dashboard-data.mjs's own TOPIC_TABLES map). Computed below
  // from `topic` once it's known, instead of trusted from the LLM.
  let tablesUsed = [];

  // The draft agent's own intent (answer | ask_clarification) and the
  // separate report-gate classifier (wantsReport) are independent signals
  // that can disagree -- e.g. "give me a report on whichever's bigger,
  // regions or products" reads as report-seeking to the report gate, but
  // the draft agent correctly set intent: "ask_clarification" and never
  // called the tool at all. Previously wantsReport alone decided the final
  // intent, so that case silently created a full report page (built from
  // whatever default/unscoped data happened to be lying around, since no
  // tool call ever ran) with the clarifying QUESTION as its narrative --
  // the user would see a page they never asked for instead of being asked
  // the question. A clarifying question must always win: it always renders
  // as plain text with no data fetch, no matter what the report gate says.
  const askedClarification = structured?.intent === 'ask_clarification';
  const intent = askedClarification ? 'answer' : (wantsReport.wantsReport ? 'create_new_page' : 'answer');
  const topic = structured?.topic ?? 'dashboard';
  // FIX 2026-09-17: the guardrail prompt tells the model never to call a
  // tool when it's asking a clarifying question -- but instruction-
  // following alone isn't reliable (same lesson as the narrative/
  // tablesUsed fixes above), and live testing proved it: the model asked a
  // clarifying question about a PACKAGE report while a tool call had
  // already fired and topic had fallen back to "dashboard", which made
  // tablesUsed report fact_ticket (dashboard's fallback table list) next
  // to a question that had nothing to do with tickets. A clarifying
  // question, by definition, isn't grounded in any real lookup -- so when
  // askedClarification is true, tablesUsed is forced empty here in code,
  // regardless of what calledAnyTool/topic came back as.
  tablesUsed = askedClarification ? [] : calledAnyTool ? tablesForTopic(topic) : [];
  // A real warehouse tool call ran this turn even when intent stayed
  // "answer" -- e.g. a correction/follow-up ("i meant billing, not
  // collections") that never says the word "report" or "chart", so the
  // report-gate classifier reads it as a plain question, not a request to
  // see a page. A real tool call that was actually just made is always
  // worth returning a fresh dashboardData() for, so the UI can keep
  // whatever it's showing in sync with it, regardless of which label the
  // report gate put on this turn. (The old version tracked this via
  // metricQueriesUsed/comparePreviousPeriodUsed, which no longer exist --
  // calledAnyTool is the direct equivalent for the new fixed-tool set.)
  // Regex fallback ONLY for the rare case a report was requested but no
  // tool call happened to run this exact turn (e.g. a plain follow-up that
  // re-renders a prior breakdown) -- popFinancialsArgs (recovered from the
  // model's real tool call above) is always preferred when it exists, since
  // it reflects genuine understanding of the request (limit AND direction),
  // not just a literal "top N" text match.
  const fallbackLimit = popFinancialsArgs?.limit ?? extractExplicitLimit(message);
  // FIX 2026-09-17: this used to be `intent === 'answer' && !calledAnyTool`
  // -- but askedClarification ALSO forces intent to 'answer' (see above),
  // so if the model broke its own "never call a tool while asking a
  // clarifying question" rule, calledAnyTool became true and this branch
  // fetched and returned a FULL dashboardData() bundle (topic stuck at its
  // "dashboard" fallback) right alongside the clarifying question --
  // exactly what put a POP table on screen under a package-report
  // question. A clarifying question is never grounded in a real lookup,
  // so data must be null here unconditionally when askedClarification is
  // true, no matter what calledAnyTool says.
  const data = askedClarification || (intent === 'answer' && !calledAnyTool)
    ? null
    : await dashboardData({
        windowDays: usedArgs.days,
        region: usedArgs.region,
        limit: fallbackLimit,
        sortBy: popFinancialsArgs?.sortBy,
        direction: popFinancialsArgs?.direction,
        // PERF FIX 2026-09-17: pass the model's own chosen topic through so
        // dashboardData only fetches the ONE expensive breakdown this
        // question actually needs, instead of every breakdown in the
        // system on every single chat turn (see dashboard-data.mjs's own
        // comment on this -- that unconditional-fetch-everything pattern
        // was the real cause of "simple" questions timing out).
        topic: structured?.topic ?? null,
      });

  // FIX 2026-09-17: the narrative's "notable pattern" sentence was left to
  // the draft LLM's free judgment, even after the prompt was updated to
  // tell it to cite collectionRate/billedShare -- live testing proved
  // instruction-following alone isn't reliable enough for a BI tool (the
  // model kept omitting the percentage despite the instruction). This
  // computes and APPENDS a guaranteed, deterministic insight sentence in
  // code, straight from the same real fields (collectionRate, billedShare,
  // revenuePerActiveCustomer) already computed in revenueService.mjs --
  // never invented here, never subject to the model changing its mind.
  const baseNarrative =
    typeof structured?.narrative === 'string' && structured.narrative.trim()
      ? structured.narrative.trim()
      : 'I could not compute a grounded answer from the available data.';
  const deterministicInsight = buildDeterministicInsight(topic, data);
  const narrative = deterministicInsight ? `${baseNarrative} ${deterministicInsight}` : baseNarrative;

  // FIX 2026-09-17: requestedMetrics -- exactly which financial columns the
  // user named this turn (e.g. "total billed, total refunded, total
  // adjusted, plus outstanding" has no "collected") -- so report-table.ts
  // can render ONLY those columns instead of always showing every column
  // get_pop_financials/get_package_financials/get_customer_financials
  // happens to return. Validated against the known set here too, not just
  // trusted from the model.
  const VALID_REQUESTED_METRICS = ['billed', 'collected', 'refunded', 'adjusted', 'outstanding', 'activeCustomers', 'count', 'avgResolutionHours', 'byTranMode', 'packageName'];
  const requestedMetrics = Array.isArray(structured?.requestedMetrics)
    ? structured.requestedMetrics.filter((m) => VALID_REQUESTED_METRICS.includes(m))
    : [];

  return {
    intent,
    // FIX 2026-09-17: surfaced separately from `intent` (which is always
    // normalized to 'answer'/'create_new_page' for the rest of the app's
    // existing contract) so the frontend can tell a genuine clarifying
    // question apart from a normal answer, and avoid showing a stale
    // report panel next to a question that hasn't been answered yet.
    askedClarification,
    topic,
    title:
      typeof structured?.title === 'string' && structured.title.trim()
        ? structured.title.trim().slice(0, 120)
        : topic === 'dashboard'
          ? 'Dashboard Update'
          : `${topic[0].toUpperCase()}${topic.slice(1)} View`,
    narrative,
    filters: usedArgs,
    tablesUsed,
    data: data ? { ...data, requestedMetrics } : data,
  };
}
