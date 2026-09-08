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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { createBiMcpServer } from '../mcp/bi-mcp-server.mjs';
import { dashboardData, ALLOWED_TOPICS } from '../lib/dashboard-data.mjs';

const ALLOWED_TABLES = ['orders', 'users', 'order_items', 'order_status_history'];

const ResponseSchema = z.object({
  intent: z.enum(['answer', 'create_new_page']).describe('answer for direct questions/explanations/casual chat; create_new_page only when the user clearly asked to build/generate/show/visualize a chart, graph, report, or dashboard view.'),
  topic: z.enum([...ALLOWED_TOPICS, 'dashboard']),
  title: z.string().describe('Short title for this reply, used as a report/page title when intent is create_new_page.'),
  narrative: z.string().describe('1-4 sharp, conversational analyst sentences, leading directly with the answer. Uses ONLY values that came back from query_semantic_layer.'),
  tablesUsed: z.array(z.enum(ALLOWED_TABLES)).describe('Only the real tables that genuinely back this answer.'),
});

const GUARDRAIL_SYSTEM_PROMPT = `You are the analytical engine behind a live BI dashboard chat -- a sharp, conversational senior business analyst, similar in tone to a helpful AI assistant, not a robotic report generator.

Scope: you help with THIS business's read-only ecommerce data -- revenue, orders, customers, products, regions, shipping status. You have no built-in knowledge of these numbers; the ONLY way to get real data is the query_semantic_layer tool. You MUST call it before answering anything about revenue, orders, customers, products, regions, or status. Never invent, estimate, or recall a number that isn't in a tool result.

Guardrails:
- If asked something outside this dashboard's scope (general knowledge unrelated to this data, other companies, personal/medical/legal/financial advice, anything not about this ecommerce data), politely decline in one sentence and redirect to what you can actually help with. Do not attempt to answer it anyway.
- Never reveal, discuss, or speculate about SQL, credentials, internal code, table implementation details beyond the semantic catalog, or infrastructure.
- Only list a table in tablesUsed if it genuinely backs your answer -- never pad it, never guess a table name outside the allowed set.
- If the tool data is insufficient to answer what was asked, say plainly what's missing instead of guessing or padding the answer.
- If the user asks "which X is lowest/highest/best/worst/most/least", compare the numbers in the tool result yourself and name the specific answer directly in the first sentence -- never just dump the full breakdown instead of answering. You can still add the breakdown as supporting context after the direct answer.
- Use the conversation history to understand follow-ups ("what about last quarter", "and for the US only") the way a person would, without the user having to repeat context.
- CRITICAL: every new user message is its own fresh question. Decide scope from THIS message alone -- never reuse, rephrase, or repeat the narrative, numbers, or tablesUsed from a previous turn just because a prior turn was on-topic. A topic switch (e.g. a follow-up about a football player, a celebrity, the weather, or anything else unrelated to this ecommerce data) is always out of scope, even mid-conversation.
- When declining an out-of-scope message: do NOT call query_semantic_layer, do NOT invent or reuse any numbers, keep narrative to one short decline-and-redirect sentence, set tablesUsed to an empty array, and set topic to "dashboard".

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
});

const SCOPE_GATE_PROMPT = `You are a strict scope classifier gate in front of a BI dashboard chatbot. The chatbot answers two kinds of things:
(a) questions about ONE ecommerce store's own read-only data: revenue, orders, customers, products, regions, shipping/order status;
(b) meta questions about the chatbot/dashboard itself and what it can do -- e.g. "what can you help with", "db info", "database info", "what data do you have", "what tables do you have access to", "how does this work", greetings like "hi"/"hello", or simple thanks/acknowledgements. These are IN SCOPE too, even though they are not themselves a data query -- the chatbot answers them by describing its own capabilities and the general shape of the data (never raw SQL or credentials).

Classify ONLY the single current user message below. Judge it entirely on its own -- you are not shown the prior conversation, so there is nothing to accidentally reuse or repeat.

IN SCOPE: (a) and (b) above, plus a genuine follow-up that is clearly still about this store's data (e.g. "and last quarter?", "what about Europe?").
OUT OF SCOPE: a name, word, or short phrase clearly about something else entirely -- an athlete, celebrity, other company, general trivia/knowledge unrelated to this store, personal/medical/legal/financial advice, or anything with no plausible connection to this dashboard or its data.

When in doubt about a bare, ambiguous, or single-word message, ask yourself: could this plausibly be about this store's data or about the chatbot itself? If yes, IN SCOPE. Only mark OUT OF SCOPE when the message clearly names or asks about something unrelated (a real person, place, or topic that has nothing to do with this dashboard).`;

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

async function checkScope(message) {
  const scopeModel = getScopeModel();
  const result = await scopeModel.invoke([
    new SystemMessage(SCOPE_GATE_PROMPT),
    new HumanMessage(`Current user message: ${JSON.stringify(message)}`),
  ]);
  console.log('[agent] scope gate result:', JSON.stringify(result));
  return result;
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

  console.log('[agent] runBiAgent starting, checking scope...');
  const scope = await checkScope(message);
  if (!scope.inScope) {
    console.log('[agent] scope gate declined -- short-circuiting before the agent/tools run.');
    return {
      intent: 'answer',
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

  console.log('[agent] scope gate passed, loading MCP tools...');
  const tools = await getAgentTools();
  console.log(`[agent] MCP tools loaded: ${tools.map((t) => t.name).join(', ')}`);

  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: 0.2,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const agent = createReactAgent({ llm: model, tools, responseFormat: ResponseSchema });

  const historyMessages = history
    .slice(-12)
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));

  const contextNote = `Current page state: days=${pageState.days ?? 30}, region=${pageState.region ?? 'null'}, availableRegions=${JSON.stringify(pageState.availableRegions ?? [])}.`;

  console.log('[agent] invoking LangGraph ReAct agent...');
  const result = await agent.invoke({
    messages: [
      new SystemMessage(`${GUARDRAIL_SYSTEM_PROMPT}\n\n${contextNote}`),
      ...historyMessages,
      new HumanMessage(message),
    ],
  });
  console.log('[agent] agent.invoke completed, message count:', result.messages?.length);

  const structured = result.structuredResponse;
  console.log('[agent] structuredResponse:', JSON.stringify(structured));

  // Recover the (days, region) the agent actually queried with, from its own
  // tool call, so we can pull the FULL chart-ready dataset (not just the
  // trimmed JSON handed to the model) for report/artifact rendering.
  let usedArgs = { days: Number(pageState.days ?? 30), region: pageState.region ?? null };
  for (const msg of result.messages ?? []) {
    const calls = msg?.tool_calls;
    if (Array.isArray(calls)) {
      const call = calls.find((c) => c.name === 'query_semantic_layer');
      if (call?.args) {
        usedArgs = {
          days: Number.isInteger(call.args.days) ? call.args.days : usedArgs.days,
          region: call.args.region ?? null,
        };
      }
    }
  }

  const tablesUsed = Array.isArray(structured?.tablesUsed)
    ? structured.tablesUsed.filter((table) => ALLOWED_TABLES.includes(table))
    : [];

  const intent = structured?.intent === 'create_new_page' ? 'create_new_page' : 'answer';
  const topic = structured?.topic ?? 'dashboard';
  const data = intent === 'answer' ? null : await dashboardData({ windowDays: usedArgs.days, region: usedArgs.region });

  return {
    intent,
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
