// The real chat brain: a LangGraph ReAct agent (via LangChain's ChatOpenAI),
// talking to the BI semantic layer through an actual MCP server (see
// scripts/mcp/bi-mcp-server.mjs) instead of a hand-rolled fetch() loop. This
// replaces the old regex intent/topic classifier: the model itself decides
// when to call the tool and reasons over the real numbers it gets back, with
// conversation memory (recent turns) and scope guardrails in the system
// prompt, and a Zod-validated structured final answer so the rest of the app
// (chat UI, saved reports, "tables used" chips) keeps its existing contract.
import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { createBiMcpServer } from '../mcp/bi-mcp-server.mjs';
import { dashboardData, ALLOWED_TOPICS } from '../lib/dashboard-data.mjs';

const ALLOWED_TABLES = ['orders', 'users', 'order_items', 'order_status_history'];

const ResponseSchema = z.object({
  intent: z
    .enum(['answer', 'create_new_page', 'ask_clarification'])
    .describe(
      // NOTE: whether this becomes a saved report/chart page is decided
      // separately by a dedicated report-intent gate (checkWantsReport), not
      // by this field -- this field only controls whether you should ask a
      // clarifying question instead of proceeding.
      'answer for a normal reply once you have (or determined you cannot get) a grounded answer; ask_clarification when the request is genuinely ambiguous or missing information you need to answer correctly -- in that case do NOT call query_semantic_layer or guess a default, put your question to the user in narrative instead. create_new_page is accepted but ignored by the app -- always use answer or ask_clarification here.',
    ),
  topic: z.enum([...ALLOWED_TOPICS, 'dashboard']),
  chartType: z
    .enum(['bar', 'line', 'pie', 'donut', 'none'])
    .describe(
      'The chart format to render, IF the user asked for one. Match what they actually asked for -- "pie chart" -> pie, "line chart"/"trend"/"over time" -> line, "donut" -> donut, a plain "graph"/"chart"/"visualize" with no format named -> bar. "none" if intent is "answer" and no chart was requested.',
    ),
  title: z.string().describe('Short title for this reply, used as a report/page title when intent is create_new_page.'),
  narrative: z
    .string()
    .describe(
      // This same field is shown BOTH as the chat reply AND, verbatim, as
      // a saved report's "Insight Summary" (app/reports/[id]/page.tsx) --
      // whenever a table or chart is already rendering the actual rows, this
      // text must never become a second copy of that table in prose form.
      '2-4 sentences of STRUCTURED analysis, not a restated table. Sentence 1: the direct answer/headline finding (the specific number, name, or comparison actually asked for). Sentence 2: the single most notable pattern -- a concentration, gap, outlier, or trend the numbers show (e.g. "the top 3 customers account for over 40% of this revenue" or "Electronics is more than double the next closest category"), not just another number. Optional sentence 3: brief context (vs. a prior period, vs. an average) only if genuinely relevant. NEVER list out individual row values/names one by one when a table or chart is already showing that breakdown -- summarize what the rows MEAN, don\'t re-narrate them. Uses ONLY values that came back from query_semantic_layer.',
    ),
  tablesUsed: z.array(z.enum(ALLOWED_TABLES)).describe('Only the real tables that genuinely back this answer.'),
});

const GUARDRAIL_SYSTEM_PROMPT = `You are the analytical engine behind a live BI dashboard chat -- a sharp, conversational senior business analyst, similar in tone to a helpful AI assistant, not a robotic report generator.

Scope: you help with THIS business's read-only ecommerce data -- revenue, orders, customers, products, regions, shipping status. You have no built-in knowledge of these numbers; the ONLY way to get real data is the query_semantic_layer tool. You MUST call it before answering anything about revenue, orders, customers, products, regions, or status. Never invent, estimate, or recall a number that isn't in a tool result.


Beyond the standard dashboard bundle, query_semantic_layer also supports a flexible "metric by dimension" breakdown -- pass metric ("revenue" | "order_count" | "avg_order_value" | "units") together with groupBy ("region" | "product" | "customer" | "status" | "day") for questions that don't fit the fixed bundle, e.g. "revenue by status", "order count per customer", "units sold by product", "daily revenue trend". groupBy:"customer" genuinely JOINS orders with users -- use it for any real per-customer breakdown instead of guessing. Use sortDirection ("most"/"least") and limit for ranking questions. Always use this instead of inventing numbers or approximating from the fixed bundle when the user's question names a metric/dimension combination the fixed bundle doesn't cover.

CRITICAL -- for period-over-period questions ("this month vs last month", "vs last week", "compare to the previous period", "how does this compare to the prior 30 days"): set comparePreviousPeriod: true on the query_semantic_layer call instead of trying to call the tool twice with different "days" values. Both calls would measure trailing days from TODAY, not from two different historical windows, so two separate calls cannot actually answer this and would return the same numbers twice. comparePreviousPeriod runs one real extra query for the immediately preceding window and returns both periods' totals as periodComparison -- use ONLY those numbers, never estimate a prior period yourself. This only covers total revenue, order count, and average order value for the two windows as a whole -- it is not a per-region or per-product breakdown comparison; if the user wants a specific dimension compared across two periods, that is not supported yet and you should ask_clarification or say plainly what you can compare instead.

CRITICAL -- when the user wants MORE THAN ONE number per entity (e.g. "revenue and number of orders for each customer", "units AND revenue per product"): put the extra metric(s) in extraMetrics on the SAME query_semantic_layer call, never as a second separate call. Two separate calls are independently sorted and limited and can return different entities in a different order -- you cannot safely merge their results yourself, and doing so has produced wrong answers before (mixing up which number belongs to which entity, or inventing "unspecified" for entities the second query didn't happen to include). If a follow-up message asks to add another number to a list you just showed ("give me their order count too", "and how many orders each"), that means: re-run the SAME breakdown (same groupBy, same entities/sort as before) with the new metric added to extraMetrics -- not a fresh, differently-sorted query for a different top-N set.

CRITICAL -- if the tool result's metricBreakdown.omittedMetrics is non-empty, that means one or more metrics you asked for in extraMetrics could NOT actually be computed for this breakdown -- most commonly because a metric only makes sense for a different dimension (e.g. "units" only exists for a per-PRODUCT breakdown; it cannot be computed per-customer, per-region, or per-status at all, since only order_items has a units column). Never silently answer with fewer columns than the user asked for and say nothing about it -- always name the specific omitted metric(s) in your narrative and say plainly why (e.g. "units sold isn't tracked per customer, only per product, so here's revenue, order count, and average order value instead"). Silently dropping a requested column with no acknowledgement is exactly the kind of quiet, undetectable gap this system must never have. An entry in omittedMetrics can carry a fellBackTo field -- that means the metric you set as the PRIMARY metric (not an extra) wasn't supported for this dimension either, so the tool computed and returned fellBackTo's numbers instead, under metricBreakdown.primaryMetric/primaryLabel (which already correctly name the metric actually returned -- never relabel it back to what you originally asked for). You MUST say so explicitly in your narrative (e.g. "units sold isn't tracked per customer, so here's order count by customer instead") -- never present the returned numbers as if they were the originally requested metric.

CRITICAL -- never call query_semantic_layer twice for the SAME groupBy with two different single metrics instead of using extraMetrics (e.g. calling groupBy:"customer" once with metric:"order_count" and again with metric:"revenue" as two separate calls). Only the most recent such call is what actually gets shown to the user, so the earlier one is silently wasted at best -- and if your narrative describes numbers from that earlier, discarded call, the reply will describe a completely different set of top entities than the one actually rendered. If the request is ambiguous about which single ranking is wanted (e.g. a garbled or unclear message that could mean "rank by revenue" or "rank by order count"), pick the most reasonable single interpretation and say so in the narrative, or ask_clarification -- never hedge by querying multiple rankings and blending them in your answer.

Guardrails:
- The narrative is analysis, never a transcript of the data: when a breakdown has more than a couple of rows, do NOT enumerate each row's name and number in prose (that is what the table/chart already shows) -- instead identify the headline finding and the single most notable pattern (a concentration, gap, outlier, or trend), and stop there. A narrative that just reads the table out loud in sentence form is wrong even if every number in it is accurate.
- If asked something outside this dashboard's scope (general knowledge unrelated to this data, other companies, personal/medical/legal/financial advice, anything not about this ecommerce data), politely decline in one sentence and redirect to what you can actually help with. Do not attempt to answer it anyway.
- Never reveal, discuss, or speculate about SQL, credentials, internal code, table implementation details beyond the semantic catalog, or infrastructure.
- Only list a table in tablesUsed if it genuinely backs your answer -- never pad it, never guess a table name outside the allowed set.
- If the tool data is insufficient to answer what was asked, say plainly what's missing instead of guessing or padding the answer.
- If the user asks "which X is lowest/highest/best/worst/most/least", compare the numbers in the tool result yourself and name the specific answer directly in the first sentence -- never just dump the full breakdown instead of answering. You can still add the breakdown as supporting context after the direct answer.
- When asked for the customers with the FEWEST/LOWEST/BOTTOM orders, you MUST call query_semantic_layer with customerSort: "least" -- this runs a genuinely different query for the real bottom customers. NEVER answer a "lowest/fewest customers" question by reversing or relabeling a "most" result -- that is a different, smaller set of customers than the true bottom-N and would be factually wrong. CRITICAL -- customerSort and sortDirection are TWO SEPARATE controls, never interchangeable: customerSort ONLY affects the standard dashboard's fixed top-customers-BY-ORDER-COUNT list (no metric/groupBy needed). For ANY ranking question about customers by a DIFFERENT metric -- "bottom customers by revenue", "lowest average order value per customer", etc. -- you MUST use the flexible breakdown instead: metric + groupBy:"customer" + sortDirection:"least". Setting customerSort:"least" does NOT make a revenue-by-customer (or any other metric) breakdown return the bottom rows -- it only reorders the unrelated order-count list, while the actual metricBreakdown you report from would still silently default to "most" (the highest values) unless sortDirection is set on that same call. Always match the ranking control to which query you are actually answering from.
- Use the conversation history to understand follow-ups ("what about last quarter", "and for the US only") the way a person would, without the user having to repeat context.
- CRITICAL: every new user message is its own fresh question. Decide scope from THIS message alone -- never reuse, rephrase, or repeat the narrative, numbers, or tablesUsed from a previous turn just because a prior turn was on-topic. A topic switch (e.g. a follow-up about a football player, a celebrity, the weather, or anything else unrelated to this ecommerce data) is always out of scope, even mid-conversation.
- When declining an out-of-scope message: do NOT call query_semantic_layer, do NOT invent or reuse any numbers, keep narrative to one short decline-and-redirect sentence, set tablesUsed to an empty array, and set topic to "dashboard".
- When the user asks for a specific chart format ("pie chart", "line chart", "donut", "bar chart"), honor exactly that format in chartType -- never silently substitute a different chart type than what was asked for.
- If the request is genuinely ambiguous or missing something you need to answer correctly or usefully -- e.g. "compare them" with no clear referents, "show me the report" with no topic named and nothing to infer from recent history, a metric+dimension combination that could mean two different things -- set intent to "ask_clarification" and put ONE short, specific question in narrative (e.g. "Which two would you like compared -- regions, products, or time periods?"). Do NOT call query_semantic_layer and do NOT guess a default in this case. Only ask when you genuinely cannot proceed correctly without it -- don't ask for confirmation on things you can reasonably infer from the message or recent conversation (a bare "generate a graph" right after a data answer is NOT ambiguous, it clearly means chart that data).

Example -- out-of-scope follow-up:
User: "which region has the lowest revenue?"
Assistant: (calls query_semantic_layer, answers with real numbers, tablesUsed: ["orders"])
User: "can you tell me about messi?"
Assistant: narrative: "I'm focused on this store's ecommerce data, so I can't help with that -- ask me about revenue, orders, customers, products, or regions instead." tablesUsed: [] topic: "dashboard" intent: "answer"`;

const ScopeSchema = z.object({
  inScope: z
    .boolean()
    .describe(
      'true only if this message is asking about, or is a natural continuation of asking about, THIS ecommerce store\'s own read-only data: revenue, orders, customers, products, regions, or shipping/order status. false for anything else -- other companies, public figures, celebrities, athletes, general knowledge, personal/medical/legal/financial advice, small talk unrelated to the data, or requests about SQL/credentials/infrastructure.',
    ),
  declineReason: z
    .string()
    .describe('If inScope is false, ONE short, friendly sentence declining and redirecting to what you can help with (revenue, orders, customers, products, regions, status). Empty string if inScope is true.'),
  isGreetingOrMeta: z
    .boolean()
    .describe(
      'true if this message is a greeting ("hi", "hello", "hey"), simple thanks/acknowledgement, or a meta question about the chatbot itself ("what can you help with", "what do you do", "how does this work") -- i.e. it needs NO real data lookup at all, just a capabilities reply. false for anything that is actually asking about revenue/orders/customers/products/regions/status data, even loosely. Only meaningful when inScope is true.',
    ),
});

const SCOPE_GATE_PROMPT = `You are a strict scope classifier gate in front of a BI dashboard chatbot. The chatbot answers two kinds of things:
(a) questions about ONE ecommerce store's own read-only data: revenue, orders, customers, products, regions, shipping/order status;
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
      'true if answering this message well requires looking up a real number, count, date, or record from this store\'s data (revenue, orders, customers, products, regions, or shipping/order status) -- even a vague, short, or typo-ridden data question still counts as true. false only if the message could be fully and honestly answered with no data lookup at all -- a greeting, thanks, or a question about the chatbot/dashboard itself and what it can do.',
    ),
});

const NEEDS_DATA_PROMPT = `You classify a single user message for a BI dashboard chatbot. Decide ONLY this: to answer this message well, does the chatbot need to look up real data from this ecommerce store (revenue, orders, customers, products, regions, shipping/order status)?

true: any question, however short, vague, or typo-ridden, that is asking about this store's actual numbers or records -- "revenue by customer", "need total revenue for each custoemr", "top products", "how many orders last week", "which region is lowest".
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

// The agent can call query_semantic_layer more than once in a single turn
// for the SAME groupBy dimension -- a draft/critique retry re-running the
// same breakdown with corrected args, or an ambiguous request causing two
// differently-sorted/limited queries for the same dimension. Whatever
// finally becomes the rendered `data` only ever reflects the LAST call for
// a given groupBy (see the metricQueriesUsed dedup below, in runBiAgent) --
// so grounding the narrative against every tool call this turn, including
// ones that got superseded and excluded from what's actually rendered, let
// a narrative cite real numbers from a DISCARDED call and still pass the
// critique gate as "grounded," while the table/chart the user actually
// sees came from the different, later call. That produced a narrative and
// a table describing two genuinely different query results in the same
// report, with no error anywhere in the pipeline. This mirrors the exact
// same "last call per groupBy wins" rule used to build `data`, so the
// critique step can never certify a narrative against a call that isn't
// the one the user ends up looking at.
export function extractWinningToolOutputs(messages) {
  const callInfoById = new Map();
  for (const m of messages) {
    const calls = m?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call?.id) callInfoById.set(call.id, { name: call.name, args: call.args ?? {} });
    }
  }

  const winningByGroupBy = new Map();
  const otherOutputs = [];
  for (const m of messages) {
    if (m?.getType?.() !== 'tool') continue;
    const info = callInfoById.get(m.tool_call_id);
    const content = String(m.content).slice(0, 4000);
    if (info?.name === 'query_semantic_layer' && info.args?.metric && info.args?.groupBy) {
      // Overwrite, never append -- only the most recent call for this
      // dimension should ever be treated as ground truth, exactly matching
      // which call's data actually gets rendered.
      winningByGroupBy.set(info.args.groupBy, content);
    } else {
      otherOutputs.push(content);
    }
  }
  return [...otherOutputs, ...winningByGroupBy.values()];
}

async function draftNode(state) {
  const tools = await getAgentTools();
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0.2,
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
        `Your previous answer contained figures that could not be verified against the real tool results: ${result.issues.join('; ')}. Re-check the actual data (call query_semantic_layer again if needed) and rewrite your narrative using ONLY numbers that genuinely appear there.`,
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
  const server = createBiMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bi-dashboard-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cachedTools = await loadMcpTools('bi-semantic-layer', client);
  return cachedTools;
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
      chartType: 'none',
      title: 'Out of Scope',
      narrative:
        scope.declineReason && scope.declineReason.trim()
          ? scope.declineReason.trim()
          : "I'm focused on this store's ecommerce data, so I can't help with that -- ask me about revenue, orders, customers, products, regions, or status instead.",
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
      chartType: 'none',
      title: 'Hello',
      narrative:
        "Hey! I can help with revenue, orders, customers, products, regions, or shipping status for this store -- what would you like to know?",
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
  let usedArgs = { days: Number(pageState.days ?? 30), region: pageState.region ?? null };
  let customerSortUsed = 'most';
  let comparePreviousPeriodUsed = false;
  // The agent can legitimately call query_semantic_layer more than once in
  // a single turn (e.g. "units sold AND revenue for top products" needs one
  // call per metric, since each metric+groupBy call returns only one metric
  // per row). Collect ALL of them, not just the last -- overwriting used to
  // mean the narrative could describe two breakdowns while the rendered
  // table/chart only ever reflected whichever call happened to run last.
  const metricQueriesUsed = [];
  for (const msg of agentMessages) {
    const calls = msg?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call.name !== 'query_semantic_layer' || !call.args) continue;
      usedArgs = {
        days: Number.isInteger(call.args.days) ? call.args.days : usedArgs.days,
        region: call.args.region ?? null,
      };
      if (call.args.customerSort === 'least' || call.args.customerSort === 'most') {
        customerSortUsed = call.args.customerSort;
      }
      if (call.args.comparePreviousPeriod === true) {
        comparePreviousPeriodUsed = true;
      }
      if (call.args.metric && call.args.groupBy) {
        const query = {
          metric: call.args.metric,
          extraMetrics: Array.isArray(call.args.extraMetrics) ? call.args.extraMetrics : [],
          groupBy: call.args.groupBy,
          sortDirection: call.args.sortDirection === 'least' ? 'least' : 'most',
          limit: Number.isInteger(call.args.limit) ? call.args.limit : 10,
        };
        // Keep the LAST call for a given groupBy DIMENSION, never the
        // first, and never let two calls to the SAME dimension coexist as
        // separate entries just because their metric differs.
        //
        // Two things can make the agent call query_semantic_layer more than
        // once for the same groupBy in a single turn: (1) a draft ->
        // critique retry re-running the SAME breakdown with corrected args
        // (limit, sort, extraMetrics), and (2) an ambiguous prompt (e.g.
        // "products give me top 12 customers, generate report") causing the
        // model to hedge by querying the same dimension TWICE with two
        // different metrics -- say customers ranked by order_count, then
        // customers ranked by revenue -- neither call using extraMetrics,
        // so they were never meant to be merged row-by-row.
        //
        // Previously, deduping on (metric, groupBy) treated case (2) as two
        // unrelated, unrelated breakdowns: BOTH survived, dashboardData()'s
        // primary/rest split picked whichever came first as the one the
        // chart/table/export get built from, and the "rest" query got
        // merged into it by NAME (documented as not row-aligned) -- while
        // the narrative, which the LLM wrote from BOTH raw tool results
        // directly, could easily describe the OTHER ranking instead. That
        // produced a chart and a reply built from two genuinely different
        // top-N customer sets with almost no overlap between them.
        //
        // Keying on groupBy alone collapses both cases the same way: only
        // the LAST call for a given dimension survives, full stop. A
        // legitimate "more than one number per entity" request is still
        // handled correctly and safely via extraMetrics on a SINGLE call
        // (unaffected by this); this only changes what happens when the
        // model issues two SEPARATE calls to the same dimension instead of
        // using extraMetrics -- now the most recent one simply wins,
        // matching whatever the model actually ended up saying, rather than
        // silently Frankenstein-merging two different rankings. Different
        // groupBy dimensions in the same turn (e.g. "units by product AND
        // revenue by region") are unaffected -- each still gets its own
        // entry.
        const existingIndex = metricQueriesUsed.findIndex((q) => q.groupBy === query.groupBy);
        if (existingIndex >= 0) {
          metricQueriesUsed[existingIndex] = query;
        } else {
          metricQueriesUsed.push(query);
        }
      }
    }
  }

  const tablesUsed = Array.isArray(structured?.tablesUsed)
    ? structured.tablesUsed.filter((table) => ALLOWED_TABLES.includes(table))
    : [];

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
  const chartType = structured?.chartType && structured.chartType !== 'none' ? structured.chartType : 'bar';
  // A real metric+groupBy breakdown ran this turn even when intent stayed
  // "answer" -- e.g. a correction/follow-up ("i meant X") that never says
  // the word "report" or "chart", so the report-gate classifier reads it as
  // a plain question, not a request to see a page. Previously that meant
  // `data` was always null for "answer" turns, so a report/chart already on
  // screen from an earlier turn in the same conversation never got
  // refreshed -- the visible chart and table kept showing an OLDER
  // breakdown (different customers, different column count) while the
  // narrative text answered the NEW, corrected question. A real breakdown
  // that was actually just computed is always worth returning so the UI
  // can keep whatever it's showing in sync with it, regardless of which
  // label the report gate put on this turn.
  //
  // A period-over-period question ("compare this month to last month")
  // genuinely computes and uses real data (comparePreviousPeriodUsed) but
  // has no metric+groupBy breakdown at all -- there's no dimension to
  // break down, just two totals. That used to fall through the same
  // metricQueriesUsed-only check, so `data` (and therefore periodComparison)
  // was silently discarded even though the narrative was built from real,
  // freshly-queried numbers.
  const hasFreshBreakdown = metricQueriesUsed.length > 0 || comparePreviousPeriodUsed;
  const data =
    intent === 'answer' && !hasFreshBreakdown
      ? null
      : await dashboardData({
          windowDays: usedArgs.days,
          region: usedArgs.region,
          customerSort: customerSortUsed,
          metricQueries: metricQueriesUsed,
          comparePreviousPeriod: comparePreviousPeriodUsed,
        });

  return {
    intent,
    topic,
    chartType,
    title:
      typeof structured?.title === 'string' && structured.title.trim()
        ? structured.title.trim().slice(0, 120)
        : topic === 'dashboard'
          ? 'Dashboard Update'
          : `${topic[0].toUpperCase()}${topic.slice(1)} View`,
    narrative:
      typeof structured?.narrative === 'string' && structured.narrative.trim()
        ? structured.narrative.trim()
        : 'I could not compute a grounded answer from the available data.',
    filters: usedArgs,
    tablesUsed,
    data,
  };
}
