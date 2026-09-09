import http from 'node:http';
import { dashboardData } from './lib/dashboard-data.mjs';
import { runBiAgent } from './chat/agent.mjs';

const port = Number(process.env.API_PORT ?? 4100);

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

// Public entry point: the real LangGraph agent, and only the real agent.
// There used to be two silent fallback tiers here -- a second plain
// tool-calling loop, then a hardcoded keyword/regex classifier -- that
// kicked in on ANY error from the real agent (a transient API hiccup, a
// bug, anything) with no visibility to the user that a much dumber pipeline
// had taken over. That's removed. If the real agent fails, the request
// fails and the error is returned to the caller -- see the /api/chat
// handler's catch block above -- instead of silently degrading to a worse
// answer that looks the same as a good one.
async function handleChatMessage(message, pageState, history = []) {
  if (!message.trim()) {
    throw new Error('Message is empty.');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  return runBiAgent({ message, history, pageState });
}
