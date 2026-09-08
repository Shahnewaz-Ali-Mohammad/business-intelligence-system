import http from 'node:http';
import {
  dbConfig,
  toNumber,
  compactMoney,
  readOnlyQuery,
  dashboardData,
  ALLOWED_TOPICS,
  TOPIC_TABLES,
  tablesForTopic,
} from './lib/dashboard-data.mjs';
import { runBiAgent } from './chat/agent.mjs';

const port = Number(process.env.API_PORT ?? 4100);
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, `http://localhost:${port}`);

  if (requestUrl.pathname === '/api/chat' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message ?? '').slice(0, 500);
        const pageState = payload.page_state ?? {};
        const history = Array.isArray(payload.history)
          ? payload.history
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
              .slice(-12)
          : [];
        console.log(`[chat] incoming message: ${JSON.stringify(message)}`);
        const result = await handleChatMessage(message, pageState, history);
        console.log(`[chat] responded via pipeline, intent=${result.intent}, narrative="${result.narrative.slice(0, 120)}"`);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        console.error('[chat] request failed entirely:', error);
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Could not handle chat request',
          }),
        );
      }
    });
    return;
  }

  if (requestUrl.pathname !== '/api/dashboard' || request.method !== 'GET') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Both params are always sent as query-string params (never string-interpolated
  // into SQL) -- readOnlyQuery uses parameterized placeholders throughout -- but we
  // still validate their shape here so a stray value can't silently no-op the filter.
  const rawDays = Number(requestUrl.searchParams.get('days'));
  const windowDays = Number.isInteger(rawDays) && rawDays > 0 && rawDays <= 365 ? rawDays : 30;

  const rawRegion = requestUrl.searchParams.get('region');
  const region = rawRegion && /^[A-Za-z]{2,10}$/.test(rawRegion) ? rawRegion.toUpperCase() : null;

  try {
    const data = await dashboardData({ windowDays, region });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Database read failed',
      }),
    );
  }
});

server.listen(port, () => {
  console.log(`Read-only BI API listening at http://localhost:${port}/api/dashboard`);
});

function parseDays(message, fallbackDays) {
  const lower = message.toLowerCase();
  const explicit = lower.match(/last\s+(\d{1,3})\s*(day|days|d)\b/);
  if (explicit) {
    const days = Number(explicit[1]);
    if (Number.isInteger(days) && days > 0 && days <= 365) return days;
  }
  if (lower.includes('week') || lower.includes('7 day')) return 7;
  if (lower.includes('month') || lower.includes('30 day')) return 30;
  if (lower.includes('quarter') || lower.includes('90 day')) return 90;
  if (lower.includes('year') || lower.includes('365 day')) return 365;
  return fallbackDays;
}

function parseRegion(message, pageState) {
  const lower = message.toLowerCase();
  if (lower.includes('all region') || lower.includes('all countries') || lower.includes('clear region')) {
    return null;
  }

  const currentRegions = Array.isArray(pageState.availableRegions)
    ? pageState.availableRegions.map((region) => String(region).toUpperCase())
    : [];

  for (const region of currentRegions) {
    if (lower.includes(region.toLowerCase())) return region;
  }

  const regionMatch = lower.match(/\b(us|de|at|br|fr|uk|ca|au|in|bd)\b/);
  return regionMatch ? regionMatch[1].toUpperCase() : pageState.region ?? null;
}

// Keyword sets per topic, including natural synonyms real users type ("sales"
// for revenue, "buyers" for customers, "delivery" for shipping) and both
// singular/plural forms, so topic detection doesn't miss what the user
// actually said. Matched with word boundaries to avoid partial-word hits.
const TOPIC_KEYWORDS = {
  revenue: ['revenue', 'sales', 'sale', 'income', 'earnings', 'turnover'],
  orders: ['order', 'orders', 'order volume', 'purchases'],
  customers: ['customer', 'customers', 'buyer', 'buyers', 'repeat customer', 'repeat customers', 'client', 'clients'],
  products: ['product', 'products', 'sku', 'item', 'items', 'best seller', 'bestseller'],
  regions: ['region', 'regions', 'country', 'countries', 'geo', 'geography', 'market', 'markets'],
  status: ['status', 'delivered', 'pending', 'cancelled', 'canceled', 'processing status'],
  shipping: ['shipping', 'delivery', 'fulfillment', 'shipment'],
};

function detectTopic(message) {
  const lower = message.toLowerCase();
  for (const topic of ALLOWED_TOPICS) {
    const keywords = TOPIC_KEYWORDS[topic] ?? [topic];
    const matched = keywords.some((keyword) => new RegExp(`\\b${keyword}\\b`).test(lower));
    if (matched) return topic;
  }
  return 'dashboard';
}

function isCasualChat(message) {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
  return [
    'hi',
    'hello',
    'hey',
    'yo',
    'thanks',
    'thank you',
    'ok',
    'okay',
  ].includes(normalized);
}

function detectIntent(message) {
  const lower = message.toLowerCase();
  if (isCasualChat(message)) return 'answer';

  const answerWords = [
    'what is',
    'what does',
    'explain',
    'define',
    'why',
    'how is',
    'how do',
    'how many',
    'how much',
    'tell me',
    'summarize',
    'what are',
    'which',
  ];
  if (answerWords.some((word) => lower.includes(word))) return 'answer';

  const createWords = [
    'create',
    'generate',
    'build',
    'make',
    'show chart',
    'show graph',
    'new page',
    'new report',
    'new dashboard',
    'breakdown',
    'visualize',
    'plot',
  ];
  if (createWords.some((word) => lower.includes(word))) return 'create_new_page';

  const mutateWords = ['filter', 'switch', 'change', 'update', 'only', 'last ', 'region'];
  if (mutateWords.some((word) => lower.includes(word))) return 'mutate_current_page';

  return 'answer';
}

function fallbackPlan(message, pageState) {
  const fallbackDays = Number(pageState.days ?? 30);
  return {
    intent: detectIntent(message),
    topic: detectTopic(message),
    days: parseDays(message, fallbackDays),
    region: parseRegion(message, pageState),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function planWithOpenAI(message, pageState) {
  if (!process.env.OPENAI_API_KEY) return fallbackPlan(message, pageState);

  const fallback = fallbackPlan(message, pageState);
  const availableRegions = Array.isArray(pageState.availableRegions)
    ? pageState.availableRegions.map((region) => String(region).toUpperCase())
    : [];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: openAiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You classify BI dashboard user requests. Return only JSON. Never write SQL. Allowed intents: answer, mutate_current_page, create_new_page. Use answer for greetings, casual chat, definitions, explanations, simple factual questions, summaries, and "what does X mean". Use create_new_page only when the user clearly asks to create/generate/build/show a new chart, graph, report, dashboard, page, visualization, or breakdown. Use mutate_current_page only for direct filter/refinement requests such as changing date range or region. Allowed topics: revenue, orders, customers, products, regions, status, shipping, dashboard. Region must be null or one of the available region codes. Days must be one of 7, 30, 90, 365 unless the user explicitly asks a number from 1 to 365.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              message,
              currentPageState: {
                days: pageState.days ?? 30,
                region: pageState.region ?? null,
                availableRegions,
                kpis: pageState.kpis ?? [],
                chartSources: pageState.chartSources ?? {},
              },
              requiredJsonShape: {
                intent: 'answer | mutate_current_page | create_new_page',
                topic: 'revenue | orders | customers | products | regions | status | shipping | dashboard',
                days: 'number',
                region: 'string | null',
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) return fallback;

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? '';
    const plan = safeJsonParse(content) ?? fallback;
    if (fallback.intent === 'answer') {
      return fallback;
    }
    const intent = ['answer', 'mutate_current_page', 'create_new_page'].includes(plan.intent)
      ? plan.intent
      : fallback.intent;
    const topic = ALLOWED_TOPICS.includes(plan.topic) ? plan.topic : fallback.topic;
    const parsedDays = Number(plan.days);
    const days =
      Number.isInteger(parsedDays) && parsedDays > 0 && parsedDays <= 365
        ? parsedDays
        : fallback.days;
    const region =
      plan.region === null || plan.region === undefined
        ? null
        : availableRegions.includes(String(plan.region).toUpperCase())
          ? String(plan.region).toUpperCase()
          : fallback.region;

    return { intent, topic, days, region };
  } catch (error) {
    console.error('OpenAI planning failed, using deterministic fallback:', error.message);
    return fallback;
  }
}

function answerFromComputedData(message, plan, data) {
  const lower = message.toLowerCase();
  const revenue = data.kpis.find((kpi) => kpi.label === 'Revenue')?.value ?? 'unknown revenue';
  const orders = data.kpis.find((kpi) => kpi.label === 'Orders')?.value ?? 'unknown orders';
  const customers =
    data.kpis.find((kpi) => kpi.label === 'Active Customers')?.value ?? 'unknown customers';
  const aov = data.kpis.find((kpi) => kpi.label === 'Average Order Value')?.value ?? 'unknown AOV';
  const scope = `${plan.region ?? 'all regions'} over ${plan.days} days`;

  if (isCasualChat(message)) {
    return 'Hi. I can answer questions from the ecommerce database, explain the KPI numbers, or create a new analysis view when you ask for a chart, breakdown, or report.';
  }
  if (lower.includes('changed_at')) {
    return 'changed_at is the timestamp for when a record changed state. In order_status_history, it means when an order moved into a status such as pending, paid, cancelled, or delivered.';
  }
  if (lower.includes('average order value') || lower.includes('aov')) {
    return `Average Order Value is revenue divided by orders. For ${scope}, AOV is ${aov}, calculated from ${revenue} and ${orders} orders.`;
  }
  if (lower.includes('revenue')) {
    return `Revenue for ${scope} is ${revenue}. This comes from captured payment/order totals in the read-only ecommerce database.`;
  }
  if (lower.includes('customer')) {
    return `The users table currently has ${customers} active customers. Repeat-customer details come from linked order history where the schema supports it.`;
  }
  if (lower.includes('status')) {
    const statusText = data.channelRevenue
      .map((row) => `${row.name}: ${row.value}`)
      .join(', ');
    return `Order status counts for ${scope}: ${statusText}.`;
  }
  if (lower.includes('product')) {
    const asksLowest = /\b(lowest|worst|least|bottom|smallest|weakest)\b/.test(lower);
    if (asksLowest && data.topProducts.length) {
      const worst = data.topProducts[data.topProducts.length - 1];
      return `The lowest-performing product (all-time) is ${worst[0]} at ${worst[1]}. This comes from order_items revenue rollups, not scoped to ${plan.days} days.`;
    }
    const products = data.topProducts
      .slice(0, 3)
      .map((row) => `${row[0]} (${row[1]})`)
      .join(', ');
    return `Top products (all-time): ${products}. These values come from order_items revenue rollups and are not scoped to ${plan.days} days.`;
  }
  if (lower.includes('region')) {
    const regions = data.regionRevenue
      .slice(0, 5)
      .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
      .join(', ');
    if (lower.includes('how many')) {
      return `There are ${data.regionRevenue.length} regions in the current DB result: ${data.regionRevenue.map((row) => row.region).join(', ')}.`;
    }

    // Superlative questions ("which region has the lowest/highest sales")
    // must answer directly, not just dump the whole breakdown.
    const asksLowest = /\b(lowest|worst|least|bottom|smallest|weakest)\b/.test(lower);
    const asksHighest = /\b(highest|best|top|most|biggest|largest|leading)\b/.test(lower);
    if ((asksLowest || asksHighest) && data.regionRevenue.length) {
      const sorted = [...data.regionRevenue].sort((a, b) => toNumber(a.revenue) - toNumber(b.revenue));
      const target = asksLowest ? sorted[0] : sorted[sorted.length - 1];
      const label = asksLowest ? 'lowest' : 'highest';
      return `The ${label} sales region for ${scope} is ${target.region}, at ${compactMoney.format(toNumber(target.revenue))}. Full breakdown: ${regions}.`;
    }

    return `Revenue by region for ${scope}: ${regions}.`;
  }
  return `For ${scope}, revenue is ${revenue}, orders are ${orders}, active customers are ${customers}, and average order value is ${aov}.`;
}

// Topic-specific, grounded report text. Each branch only reads the sub-slice of
// `data` that topic actually maps to, so "products" never talks about regions and
// vice versa -- this used to collapse to one generic paragraph for every topic,
// which is the main reason chat replies felt inaccurate/generic.
function reportFromComputedData(plan, data) {
  const scope = `${plan.region ?? 'all regions'}, ${plan.days} day window`;
  const findKpi = (label) => data.kpis.find((kpi) => kpi.label === label);
  const revenueKpi = findKpi('Revenue');
  const ordersKpi = findKpi('Orders');
  const aovKpi = findKpi('Average Order Value');
  const customersKpi = findKpi('Active Customers');

  switch (plan.topic) {
    case 'revenue': {
      if (!revenueKpi) return `No revenue data was returned for ${scope}.`;
      return `Revenue report for ${scope}: total revenue is ${revenueKpi.value}. ${revenueKpi.detail}. ${revenueKpi.footer} Source: orders.grand_total, captured payments only.`;
    }

    case 'orders': {
      if (!ordersKpi) return `No order data was returned for ${scope}.`;
      return `Order volume report for ${scope}: ${ordersKpi.value} orders placed. ${ordersKpi.detail}. ${ordersKpi.footer} Source: orders table row count.`;
    }

    case 'customers': {
      const mixSentence = data.customerMix
        ? `${data.customerMix.newPct}% of active-window customers are new and ${data.customerMix.returningPct}% are returning.`
        : 'New-vs-returning split is not available on this schema.';
      const topCustomerSentence =
        data.topCustomersByOrders.length > 0
          ? `Top repeat customer: ${data.topCustomersByOrders[0].name} with ${data.topCustomersByOrders[0].orders} orders.`
          : 'No repeat-customer rows were found (no customer-linking column detected, or no repeat orders).';
      return `Customer report for ${scope}: ${customersKpi?.value ?? 'unknown'} active customers. ${mixSentence} ${topCustomerSentence} Source: users.is_active joined to orders.`;
    }

    case 'products': {
      if (data.topProducts.length === 0) return `No product revenue rows were returned for ${scope}.`;
      const lines = data.topProducts
        .slice(0, 5)
        .map((row) => `${row[0]}: ${row[1]} revenue (${row[2]} share, ${row[3]} units)`)
        .join('; ');
      return `Product report (all-time, not scoped to ${plan.days} days -- order_items has no verified date column): ${lines}. Source: order_items.product_name + line_total.`;
    }

    case 'regions': {
      if (data.regionRevenue.length === 0) return `No regional revenue rows were returned for ${scope}.`;
      const lines = data.regionRevenue
        .slice(0, 5)
        .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
        .join(', ');
      return `Regional revenue report for ${scope}: ${lines}. Source: orders.ship_country_code + grand_total.`;
    }

    case 'status': {
      if (data.channelRevenue.length === 0) return `No order-status rows were returned for ${scope}.`;
      const total = data.channelRevenue.reduce((sum, row) => sum + row.value, 0);
      const lines = data.channelRevenue
        .map((row) => `${row.name}: ${row.value}${total ? ` (${Math.round((row.value / total) * 1000) / 10}%)` : ''}`)
        .join(', ');
      return `Order status report for ${scope}: ${lines}. Source: orders.status.`;
    }

    case 'shipping': {
      if (data.regionRevenue.length === 0) return `No shipping-region rows were returned for ${scope}.`;
      const lines = data.regionRevenue
        .slice(0, 5)
        .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
        .join(', ');
      return `Shipping-region breakdown for ${scope}: ${lines}. Source: orders.ship_country_code.`;
    }

    default: {
      const topRegion = data.regionRevenue[0];
      const topProduct = data.topProducts[0];
      const regionSentence = topRegion
        ? `${topRegion.region} is the top region at ${compactMoney.format(toNumber(topRegion.revenue))}.`
        : 'No regional revenue rows were returned for this filter.';
      const productSentence = topProduct
        ? `${topProduct[0]} is the top product at ${topProduct[1]} revenue.`
        : 'No product revenue rows were returned for this filter.';
      return `Dashboard overview for ${scope}. Revenue is ${revenueKpi?.value ?? 'unknown'}, orders total ${ordersKpi?.value ?? 'unknown'}, and AOV is ${aovKpi?.value ?? 'unknown'}. ${regionSentence} ${productSentence} Source: orders, order_items, users.`;
    }
  }
}

async function writeNarrativeWithOpenAI(message, plan, data, deterministicAnswer, tablesUsed) {
  if (!process.env.OPENAI_API_KEY) return deterministicAnswer;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: openAiModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are a senior business intelligence analyst answering inside a live dashboard chat. Use only the provided computed values -- never invent numbers, tables, columns, causes, trends, or recommendations that are not supported by them. Lead with the direct answer to the user\'s actual question in the first sentence; do not open with a generic "Dashboard overview" preamble unless the user genuinely asked for a general overview. If you reference which data this came from, use only the table names listed in tablesUsed -- never a table name outside that list. If the values are insufficient to answer, say plainly what is available and what is not, instead of guessing. Do not mention SQL. Write like a sharp analyst: 1-3 short sentences, specific numbers, no filler, no hedging, no restating the question.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: message,
              plan,
              computedValues: {
                dateRange: data.dateRange,
                activeFilter: data.activeFilter,
                kpis: data.kpis.map((kpi) => ({
                  label: kpi.label,
                  value: kpi.value,
                  detail: kpi.detail,
                  context: kpi.context,
                })),
                topRegions: data.regionRevenue,
                statusMix: data.channelRevenue.map(({ name, value }) => ({ name, value })),
                topProducts: data.topProducts.slice(0, 3),
                tablesUsed,
                deterministicAnswer,
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) return deterministicAnswer;
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content?.trim() || deterministicAnswer;
  } catch (error) {
    console.error('OpenAI narrative failed, using deterministic answer:', error.message);
    return deterministicAnswer;
  }
}

// ---------------------------------------------------------------------------
// Intelligent (tool-calling) chat pipeline.
//
// This is the real path when OPENAI_API_KEY is configured: the model is
// given ONE tool, get_business_metrics, and MUST call it to pull real numbers
// from the read-only database before it is allowed to answer anything. It
// then reasons over that JSON itself (e.g. "which region is lowest" is
// answered by the model comparing the numbers it was handed, not by a
// hand-written regex looking for the word "lowest"). This replaces the old
// keyword/regex classifier (detectIntent/detectTopic/answerFromComputedData)
// as the primary path -- those functions are kept below only as the
// deterministic fallback used when no OpenAI key is configured, or if the
// live API call fails for any reason.
// ---------------------------------------------------------------------------

const ALLOWED_TABLES = ['orders', 'users', 'order_items', 'order_status_history'];
const ALL_TOPICS_INCLUDING_DASHBOARD = [...ALLOWED_TOPICS, 'dashboard'];

const GET_METRICS_TOOL = {
  type: 'function',
  function: {
    name: 'get_business_metrics',
    description:
      'Fetch real, live metrics from the read-only ecommerce database for a given trailing day window and optional region filter. Returns revenue/order/customer KPIs, revenue by region, order status mix, and top products. You must call this before answering ANY question about revenue, orders, customers, products, regions, or status -- you have no built-in knowledge of this business\'s numbers.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'Size of the trailing day window to analyze (e.g. 7, 30, 90, 365).',
        },
        region: {
          type: ['string', 'null'],
          description: 'A region/country code to filter to (e.g. "US"), or null for all regions.',
        },
      },
      required: ['days', 'region'],
      additionalProperties: false,
    },
  },
};

async function callOpenAiChat(messages, extra = {}) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: openAiModel, temperature: 0.1, messages, ...extra }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`);
  }
  return response.json();
}

// Trim the full DashboardData payload down to what the model actually needs
// to reason over, to keep tool-result tokens small and the model focused on
// real numbers instead of chart-rendering metadata.
function summarizeForModel(data) {
  return {
    dateRange: data.dateRange,
    activeFilter: data.activeFilter,
    kpis: data.kpis.map((kpi) => ({ label: kpi.label, value: kpi.value, detail: kpi.detail })),
    regionRevenue: data.regionRevenue,
    statusMix: data.channelRevenue.map(({ name, value }) => ({ status: name, value })),
    topProducts: data.topProducts.slice(0, 10).map((row) => ({
      product: row[0],
      revenue: row[1],
      share: row[2],
      units: row[3],
      aov: row[4],
    })),
    customerMix: data.customerMix,
    repeatCustomers: data.repeatCustomers,
  };
}

function buildIntelligentResult(parsed, data, toolArgsUsed) {
  const intent = ['answer', 'mutate_current_page', 'create_new_page'].includes(parsed?.intent)
    ? parsed.intent
    : 'answer';
  const topic = ALL_TOPICS_INCLUDING_DASHBOARD.includes(parsed?.topic) ? parsed.topic : 'dashboard';
  const tablesUsed = Array.isArray(parsed?.tablesUsed)
    ? parsed.tablesUsed.filter((table) => ALLOWED_TABLES.includes(table))
    : [];
  const title =
    typeof parsed?.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 120)
      : topic === 'dashboard'
        ? 'Dashboard Update'
        : `${topic[0].toUpperCase()}${topic.slice(1)} View`;
  const narrative =
    typeof parsed?.narrative === 'string' && parsed.narrative.trim()
      ? parsed.narrative.trim()
      : 'I was not able to compute a grounded answer from the available data.';

  return {
    intent,
    topic,
    title,
    narrative,
    filters: toolArgsUsed,
    tablesUsed: tablesUsed.length ? tablesUsed : ['orders'],
    data: intent === 'answer' ? null : data,
  };
}

async function handleChatMessageIntelligent(message, pageState) {
  const availableRegions = Array.isArray(pageState.availableRegions)
    ? pageState.availableRegions.map((region) => String(region).toUpperCase())
    : [];

  const systemPrompt = `You are the analytical engine behind a live BI dashboard chat, acting as a senior business analyst. You have no built-in knowledge of this business's numbers -- the ONLY way to get real data is to call the get_business_metrics tool, and you must call it before answering anything about revenue, orders, customers, products, regions, or status. Pick the days/region window that best matches the user's question; if unspecified, use the current page state (days=${pageState.days ?? 30}, region=${pageState.region ?? 'null'}). Never invent, estimate, or recall a number that isn't in the tool result.

After the tool result comes back, respond with ONLY a JSON object, no prose or markdown fences, shaped exactly as:
{"intent": "answer" | "create_new_page", "topic": "revenue" | "orders" | "customers" | "products" | "regions" | "status" | "shipping" | "dashboard", "title": string, "narrative": string, "tablesUsed": string[]}

Rules:
- "intent" is "create_new_page" only when the user is clearly asking to build/generate/show/visualize a chart, graph, report, or dashboard view. Otherwise use "answer".
- "narrative" must be 1-3 sharp analyst sentences that lead directly with the answer to what was actually asked, using only values present in the tool result. If asked "which X is lowest/highest/best/worst", compare the numbers in the tool result yourself and name the specific answer -- never just dump the full list instead of answering.
- "tablesUsed" must only contain values from this exact list: ${JSON.stringify(ALLOWED_TABLES)}. Include only the tables actually behind your answer (e.g. a pure region-revenue question is just ["orders"]; a customer question is ["users","orders"]).
- Never mention SQL, and never fabricate a table name outside the allowed list.
- If the tool result is genuinely insufficient to answer, say plainly what's missing instead of guessing.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  let toolResultData = null;
  let toolArgsUsed = { days: Number(pageState.days ?? 30), region: pageState.region ?? null };

  for (let round = 0; round < 4; round += 1) {
    const payload = await callOpenAiChat(messages, {
      tools: [GET_METRICS_TOOL],
      tool_choice: toolResultData ? 'auto' : 'required',
      ...(toolResultData ? { response_format: { type: 'json_object' } } : {}),
    });

    const assistantMessage = payload.choices?.[0]?.message;
    if (!assistantMessage) throw new Error('OpenAI returned no response.');

    if (assistantMessage.tool_calls?.length) {
      messages.push(assistantMessage);
      for (const call of assistantMessage.tool_calls) {
        if (call.function?.name !== 'get_business_metrics') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Unknown tool.' });
          continue;
        }
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        const days =
          Number.isInteger(args.days) && args.days > 0 && args.days <= 365
            ? args.days
            : Number(pageState.days ?? 30);
        const regionRaw = args.region ? String(args.region).toUpperCase() : null;
        const region =
          regionRaw && (availableRegions.length === 0 || availableRegions.includes(regionRaw))
            ? regionRaw
            : null;
        toolArgsUsed = { days, region };
        toolResultData = await dashboardData({ windowDays: days, region });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(summarizeForModel(toolResultData)),
        });
      }
      continue;
    }

    const parsed = safeJsonParse(assistantMessage.content ?? '');
    if (!parsed) {
      if (!toolResultData) {
        messages.push({
          role: 'user',
          content: 'You must call get_business_metrics before answering. Call it now.',
        });
        continue;
      }
      return buildIntelligentResult(
        { intent: 'answer', topic: 'dashboard', narrative: assistantMessage.content, tablesUsed: ['orders'] },
        toolResultData,
        toolArgsUsed,
      );
    }
    return buildIntelligentResult(parsed, toolResultData, toolArgsUsed);
  }

  throw new Error('The assistant could not produce a grounded answer after several attempts.');
}

async function handleChatMessageDeterministic(message, pageState) {
  const plan = await planWithOpenAI(message, pageState);
  const { days, region, topic, intent } = plan;
  const data = await dashboardData({ windowDays: days, region });

  const deterministicAnswer =
    intent === 'answer' ? answerFromComputedData(message, plan, data) : reportFromComputedData(plan, data);
  const tablesUsed = tablesForTopic(topic);
  const narrative = await writeNarrativeWithOpenAI(message, plan, data, deterministicAnswer, tablesUsed);

  return {
    intent,
    topic,
    title: topic === 'dashboard' ? 'Dashboard Update' : `${topic[0].toUpperCase()}${topic.slice(1)} View`,
    narrative,
    filters: { days, region },
    tablesUsed,
    data: intent === 'answer' ? null : data,
  };
}

// Public entry point: uses the real tool-calling agent whenever an OpenAI key
// is configured, and only drops to the deterministic keyword pipeline if no
// key is set, or if the live call fails for any reason (network, rate limit,
// malformed model output) -- so the chat never goes fully dark.
// Three-tier pipeline, each tier only used if the one above it fails:
//   1. runBiAgent -- the real path: a LangGraph ReAct agent (LangChain
//      ChatOpenAI) talking to the BI data through an actual MCP server, with
//      conversation memory and scope guardrails. This is what runs normally.
//   2. handleChatMessageIntelligent -- a plain OpenAI tool-calling loop
//      (no LangGraph/MCP), kept only in case the LangGraph/MCP wiring itself
//      throws (a library bug, a version mismatch after an update, etc).
//   3. handleChatMessageDeterministic -- the old regex/keyword classifier,
//      used only when there's no OPENAI_API_KEY at all, so the chat never
//      goes fully dark.
async function handleChatMessage(message, pageState, history = []) {
  if (!message.trim()) {
    throw new Error('Message is empty.');
  }

  console.log(`[chat] OPENAI_API_KEY present: ${Boolean(process.env.OPENAI_API_KEY)}`);

  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await runBiAgent({ message, history, pageState });
      console.log('[chat] handled by tier 1 (LangGraph/MCP agent)');
      return result;
    } catch (error) {
      console.error('[chat] tier 1 (LangGraph/MCP agent) failed, falling back to tier 2:', error.stack || error.message);
    }

    try {
      const result = await handleChatMessageIntelligent(message, pageState);
      console.log('[chat] handled by tier 2 (plain OpenAI tool-calling loop)');
      return result;
    } catch (error) {
      console.error('[chat] tier 2 (plain tool-calling loop) failed, falling back to tier 3:', error.stack || error.message);
    }
  }

  console.log('[chat] handled by tier 3 (deterministic regex pipeline)');
  return handleChatMessageDeterministic(message, pageState);
}
