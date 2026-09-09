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
  narrative: z.string().describe('1-4 sharp, conversational analyst sentences, leading directly with the answer. Uses ONLY values that came back from query_semantic_layer.'),
  tablesUsed: z.array(z.enum(ALLOWED_TABLES)).describe('Only the real tables that genuinely back this answer.'),
});

const GUARDRAIL_SYSTEM_PROMPT = `You are the analytical engine behind a live BI dashboard chat -- a sharp, conversational senior business analyst, similar in tone to a helpful AI assistant, not a robotic report generator.

Scope: you help with THIS business's read-only ecommerce data -- revenue, orders, customers, products, regions, shipping status. You have no built-in knowledge of these numbers; the ONLY way to get real data is the query_semantic_layer tool. You MUST call it before answering anything about revenue, orders, customers, products, regions, or status. Never invent, estimate, or recall a number that isn't in a tool result.


Beyond the standard dashboard bundle, query_semantic_layer also supports a flexible "metric by dimension" breakdown -- pass metric ("revenue" | "order_count" | "avg_order_value" | "units") together with groupBy ("region" | "product" | "customer" | "status" | "day") for questions that don't fit the fixed bundle, e.g. "revenue by status", "order count per customer", "units sold by product", "daily revenue trend". groupBy:"customer" genuinely JOINS orders with users -- use it for any real per-customer breakdown instead of guessing. Use sortDirection ("most"/"least") and limit for ranking questions. Always use this instead of inventing numbers or approximating from the fixed bundle when the user's question names a metric/dimension combination the fixed bundle doesn't cover.

Guardrails:
- If asked something outside this dashboard's scope (general knowledge unrelated to this data, other companies, personal/medical/legal/financial advice, anything not about this ecommerce data), politely decline in one sentence and redirect to what you can actually help with. Do not attempt to answer it anyway.
- Never reveal, discuss, or speculate about SQL, credentials, internal code, table implementation details beyond the semantic catalog, or infrastructure.
- Only list a table in tablesUsed if it genuinely backs your answer -- never pad it, never guess a table name outside the allowed set.
- If the tool data is insufficient to answer what was asked, say plainly what's missing instead of guessing or padding the answer.
- If the user asks "which X is lowest/highest/best/worst/most/least", compare the numbers in the tool result yourself and name the specific answer directly in the first sentence -- never just dump the full breakdown instead of answering. You can still add the breakdown as supporting context after the direct answer.
- When asked for the customers with the FEWEST/LOWEST/BOTTOM orders, you MUST call query_semantic_layer with customerSort: "least" -- this runs a genuinely different query for the real bottom customers. NEVER answer a "lowest/fewest customers" question by reversing or relabeling a "most" result -- that is a different, smaller set of customers than the true bottom-N and would be factually wrong.
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

const CRITIQUE_PROMPT = `You are a strict fact-checker sitting between a BI chatbot and the user. You will be shown the raw tool result data the chatbot actually queried, and the narrative it drafted in response. Your only job: does every specific number, date, or figure in the narrative genuinely appear in the tool results? Do not re-derive or approve numbers you can't actually find in the data. Flag anything invented, hallucinated, stale from a previous turn, or pulled from a different breakdown than the one shown.`;

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

async function draftNode(state) {
  const tools = await getAgentTools();
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0.2,
    apiKey: process.env.OPENAI_API_KEY,
  });
  const agent = createReactAgent({ llm: model, tools, responseFormat: ResponseSchema });
  const result = await agent.invoke({ messages: state.messages });
  const toolOutputs = (result.messages ?? [])
    .filter((m) => m?.getType?.() === 'tool')
    .map((m) => String(m.content).slice(0, 4000));
  return {
    structured: result.structuredResponse,
    toolOutputs,
    lastAgentMessages: result.messages ?? [],
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

  console.log('[agent] runBiAgent starting, checking scope and report intent...');
  // Run independently of the main agent call (and of each other) -- this is
  // the same decomposition as the scope gate: one small, single-purpose,
  // temperature-0 classifier per question, instead of one big call asked to
  // write the answer AND decide page-vs-text AND stay in scope all at once.
  const [scope, wantsReport] = await Promise.all([checkScope(message, history), checkWantsReport(message, history)]);
  if (!scope.inScope) {
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

  if (scope.isGreetingOrMeta) {
    // Deterministic short-circuit, not another prompt instruction: a
    // greeting/meta message never reaches the tool-calling agent at all, so
    // there is no path left for it to "decide" to fetch a number to show
    // off with. Fixed reply, zero LLM narrative risk on this branch.
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
      if (call.args.metric && call.args.groupBy) {
        const query = {
          metric: call.args.metric,
          groupBy: call.args.groupBy,
          sortDirection: call.args.sortDirection === 'least' ? 'least' : 'most',
          limit: Number.isInteger(call.args.limit) ? call.args.limit : 10,
        };
        // Dedup identical (metric, groupBy) calls -- keep the first.
        const alreadyHave = metricQueriesUsed.some((q) => q.metric === query.metric && q.groupBy === query.groupBy);
        if (!alreadyHave) metricQueriesUsed.push(query);
      }
    }
  }

  const tablesUsed = Array.isArray(structured?.tablesUsed)
    ? structured.tablesUsed.filter((table) => ALLOWED_TABLES.includes(table))
    : [];

  const intent = wantsReport.wantsReport ? 'create_new_page' : 'answer';
  const topic = structured?.topic ?? 'dashboard';
  const chartType = structured?.chartType && structured.chartType !== 'none' ? structured.chartType : 'bar';
  const data =
    intent === 'answer'
      ? null
      : await dashboardData({
          windowDays: usedArgs.days,
          region: usedArgs.region,
          customerSort: customerSortUsed,
          metricQueries: metricQueriesUsed,
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
