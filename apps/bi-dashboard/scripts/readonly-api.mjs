// DECISION (warehouse rewiring): keep this as a separate long-lived Node
// process, rather than folding dashboardData()/runBiAgent() straight into
// Next.js API routes now that the data source is Postgres and reachable
// in-process. Reasons, weighed at the time of the rewiring:
//   1. runBiAgent() keeps its own in-memory caches (cachedTools,
//      cachedBiGraph, the OpenAI model clients) that are only worth having
//      if they survive across requests -- a Next.js API route function can
//      get re-instantiated per request/per serverless invocation depending
//      on deployment target, which would silently defeat that caching and
//      reopen the in-process MCP connection on every chat message.
//   2. dashboardData()'s own 30s result cache (see dashboard-data.mjs) has
//      the same "needs one long-lived process" requirement.
//   3. This process's error-log-to-file behavior (logErrorToFile below) and
//      its own request timeout wrapper are already tuned for exactly this
//      shape; collapsing it into Next.js API routes would mean re-solving
//      both inside route handlers instead of reusing what's already here.
//   4. The actual DB client change (MySQL -> Postgres) was fully absorbed
//      inside dashboard-data.mjs/agent.mjs -- this file never imported
//      mysql2 or any MySQL-specific code directly, so there was no
//      MySQL-shaped logic HERE that needed removing or replacing to make
//      Postgres work. The two-process shape was never actually coupled to
//      which database sat behind it.
// If a future need arises to eliminate the extra process/port (e.g. to
// simplify local dev, or because a serverless deployment target can't run
// a second long-lived process at all), the fix is to move the caches above
// into a shared module Next.js API routes can import once per server
// instance -- not to remove the caches, since they exist for real reasons.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardData } from './lib/dashboard-data.mjs';
import { runBiAgent } from './chat/agent.mjs';

// A plain append-only file next to this script, so a real failure's full
// detail (message + stack) survives even if nobody is watching this
// process's stdout at the moment it happens -- console.error alone means
// the only copy of an error lives in terminal scrollback, gone the moment
// the terminal is closed or scrolled past.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERROR_LOG_PATH = path.join(__dirname, '..', 'chat-errors.log');

function logErrorToFile(label, error) {
  try {
    const entry = `[${new Date().toISOString()}] ${label}: ${error?.stack ?? error?.message ?? String(error)}\n`;
    fs.appendFileSync(ERROR_LOG_PATH, entry);
  } catch {
    // Never let logging itself take down a request.
  }
}

const port = Number(process.env.API_PORT ?? 4100);

// This server has no auth of its own -- authentication and rate limiting
// happen in the Next.js app's /api/chat route (app/api/chat/route.ts),
// which is the only intended caller, over a plain server-to-server fetch.
// Binding to 127.0.0.1 means this port is never reachable from outside the
// machine even if something misconfigures a firewall/port-forward -- the
// wide-open CORS header that used to be here was for a direct
// browser-to-this-port call that no longer happens, so it's removed rather
// than left as a stale, unused attack surface.
const BIND_HOST = process.env.API_HOST ?? '127.0.0.1';

// Bounds how long a single request can tie up this server -- a stuck OpenAI
// or DB call used to be able to hang a request (and its DB connection)
// indefinitely. A real chat turn can legitimately involve several
// sequential OpenAI calls (scope/report/needs-data gates, a draft, a
// fact-check, and occasionally one redraft + a second fact-check), so a
// heavier request (e.g. a 20-row customer breakdown with a chart) can
// genuinely take longer than a simple one -- 40s was tight enough that a
// normal, non-buggy turn hit it and got killed. 55s gives real multi-step
// turns realistic headroom while still bounding a truly stuck call.
// FIX 2026-09-15: was 55_000. A real compound question ("total
// collected amounts and billing details for pop 1 to 100") timed out
// here -- confirmed in chat-errors.log as a plain 'Request timed out',
// no other error underneath. A two-metric ask like that can mean two
// real warehouse tool calls (get_revenue_summary + get_region_breakdown)
// plus the draft/critique redraft cycle, each a real aggregate query
// over multi-million-row fact tables -- right after the Postgres
// container was recreated (cold cache, see the shared-memory fix),
// those queries are slower than they'll be once warmed up. 90s gives a
// genuinely heavy, multi-tool-call turn realistic room -- this does not
// make the underlying queries faster, it just stops a legitimately slow
// (not broken) turn from being killed before it finishes.
const REQUEST_TIMEOUT_MS = 150_000; // FIX 2026-09-17: was 90s -- too short now that fact_collection has real 6.1M-row data to aggregate, plus the draft->critique->redraft loop can take up to 3 full LLM round-trips for one answer. Raised as an immediate unblock; the real fix is making the critique loop converge faster / cheaper (see agent.mjs's own TODO).

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Request timed out.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const server = http.createServer(async (request, response) => {
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
        const result = await withTimeout(handleChatMessage(message, pageState, history), REQUEST_TIMEOUT_MS);
        console.log(`[chat] responded via pipeline, intent=${result.intent}, narrative="${result.narrative.slice(0, 120)}"`);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        // Full detail goes to the server log only -- the caller (this
        // app's own /api/chat proxy) already turns any non-200 response
        // into a generic message before it reaches a browser, but this
        // server shouldn't be the one deciding what's safe to expose.
        console.error('[chat] request failed entirely:', error);
        logErrorToFile('[chat] request failed entirely', error);
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Could not handle chat request.' }));
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

  // PERF FIX 2026-09-17: an optional `topic` query param lets a caller that
  // only needs the cheap, always-fetched fields (plus one specific real
  // breakdown) skip the rest -- see dashboard-data.mjs's own comment on
  // `need()`. Validated against the same real topic list dashboardData
  // itself understands; anything else falls through to the full fetch
  // (needAll), matching the previous unconditional behavior exactly.
  const ALLOWED_DASHBOARD_TOPICS = ['pops', 'packages', 'trend', 'top_customers', 'tickets', 'ticket_pops', 'tran_modes', 'tran_mode_by_pop', 'tran_mode_by_package'];
  const rawTopic = requestUrl.searchParams.get('topic');
  const topic = rawTopic && ALLOWED_DASHBOARD_TOPICS.includes(rawTopic) ? rawTopic : null;

  try {
    const data = await withTimeout(dashboardData({ windowDays, region, topic }), REQUEST_TIMEOUT_MS);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  } catch (error) {
    console.error('[dashboard] request failed:', error);
    logErrorToFile('[dashboard] request failed', error);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Database read failed.' }));
  }
});

server.listen(port, BIND_HOST, () => {
  console.log(`Read-only BI API listening at http://${BIND_HOST}:${port}/api/dashboard (not reachable from outside this machine)`);
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
