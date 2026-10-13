// Authenticated proxy in front of the internal chat backend (readonly-api.mjs,
// port 4100 by default). The browser used to call that port directly via a
// NEXT_PUBLIC_ env var -- meaning ANY visitor, logged in or not, could query
// real business data and spend the OpenAI budget with no login at all, since
// that backend has no auth of its own. This route is what the browser calls
// instead: it enforces the same getCurrentUser() session check every other
// API route in this app uses, applies a lightweight per-user rate limit, and
// only THEN forwards the request to the internal backend server-side (never
// exposed to the browser).
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { createRunEvents, eventFrame, readEventStream } from '../../../scripts/lib/ag-ui-stream.mjs';

export const maxDuration = 180;

// Not NEXT_PUBLIC_ -- this URL is only ever fetched from the Next.js server,
// never sent to the browser bundle.
const CHAT_API_INTERNAL_URL = process.env.CHAT_API_INTERNAL_URL ?? 'http://localhost:4100/api/chat';

// In-memory per-user rate limit: 20 chat turns per rolling minute. Each turn
// can trigger several OpenAI calls (scope gate, report-intent gate, draft,
// fact-check, an occasional redraft), so this is a real cost/abuse control,
// not a formality. This resets on server restart and doesn't share state
// across multiple server instances -- fine for a single-instance deployment;
// a multi-instance production deployment should move this to Redis (the
// project's own architecture notes already call out Redis for exactly this
// kind of shared, cross-instance state).
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map<number, number[]>();

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const timestamps = (requestLog.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(userId, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// Bounds how long a single chat turn can hang -- a stuck OpenAI call or a
// stuck DB connection inside the backend used to be able to hold this
// request open indefinitely. Kept a few seconds above the backend's own
// internal timeout (readonly-api.mjs) so that server's own, more specific
// "Request timed out" error is what the user sees, rather than this proxy
// aborting first and masking it.
// FIX 2026-09-15: kept a few seconds above readonly-api.mjs's own
// timeout (bumped 55s -> 90s there for the same reason) so that
// server's own specific error is what the user sees, not this proxy
// aborting first.
// FIX 2026-09-28: readonly-api.mjs's own timeout was later raised again,
// 90s -> 150s (fact_collection's real 6.1M-row aggregations plus up to 3
// draft/critique/redraft round-trips can genuinely take that long), but
// this proxy's timeout was never raised to match -- it kept aborting at
// 95s, BEFORE the backend's own 150s timeout could ever fire, so every
// heavy multi-POP/multi-table report ("all pops, revenue, and customer
// count for each") hit this generic "took too long" message instead of
// either succeeding or surfacing the backend's own specific error.
const REQUEST_TIMEOUT_MS = 155_000;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to use the chat assistant.' }, { status: 401 });
  }

  if (isRateLimited(user.id)) {
    return NextResponse.json(
      { error: 'Too many requests -- please wait a moment before asking again.' },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const message = body && typeof body === 'object' && 'message' in body ? body.message : null;
  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'Enter a question to continue.' }, { status: 400 });
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: 'Keep your question within 4,000 characters. Your request has not been truncated or queried.' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  // 2026-10-13: the warehouse-setup (Cube) chat was removed. This route
  // only serves the original workspace; database workspaces use
  // /api/workspaces/[id]/chat.
  if (payload.sessionId) {
    if (typeof payload.sessionId !== 'number' || !Number.isSafeInteger(payload.sessionId) || payload.sessionId < 1) return NextResponse.json({ error: 'Invalid conversation.' }, { status: 400 });
    const [rows] = await getAppDb().execute('SELECT warehouse_id FROM chat_sessions WHERE id=? AND user_id=?', [payload.sessionId, user.id]);
    const sessions = rows as { warehouse_id: string | null }[];
    if (!sessions.length) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    if (sessions[0].warehouse_id && sessions[0].warehouse_id !== 'isp-default') return NextResponse.json({ error: 'This conversation belongs to another workspace.' }, { status: 409 });
  }
  if (req.headers.get('accept')?.includes('text/event-stream')) {
    const controller = new AbortController();
    const signal = AbortSignal.any([req.signal, controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const encoder = new TextEncoder();
    let currentText = '';
    const stream = new ReadableStream({
      async start(output) {
        let closed = false;
        const emit = (event: Record<string, unknown>) => { if (!closed && !signal.aborted) output.enqueue(encoder.encode(eventFrame(event))); };
        const run = createRunEvents(emit, { threadId: String(payload.sessionId || 'chat'), runId: crypto.randomUUID(), messageId: crypto.randomUUID() });
        const heartbeat = setInterval(() => { if (!closed && !signal.aborted) output.enqueue(encoder.encode(': heartbeat\n\n')); }, 10000);
        try {
          {
            run.progress('Understanding your question');
            const upstream = await fetch(CHAT_API_INTERNAL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
            if (!upstream.ok) throw new Error('Chat backend unavailable');
            if (upstream.headers.get('content-type')?.includes('text/event-stream') && upstream.body) {
              let finished = false;
              await readEventStream(upstream.body, (event: { type: string; name?: string; value?: unknown; delta?: string; messages?: { content: string }[] }) => {
                if (event.type === 'CUSTOM' && event.name === 'bi_progress') run.progress(event.value);
                else if (event.type === 'TEXT_MESSAGE_CONTENT') { currentText += event.delta || ''; run.text(currentText); }
                else if (event.type === 'MESSAGES_SNAPSHOT') { currentText = event.messages?.[0]?.content || ''; run.text(currentText); }
                else if (event.type === 'CUSTOM' && event.name === 'bi_result') { run.finish(event.value); finished = true; }
                else if (event.type === 'RUN_ERROR') throw new Error('Upstream run failed');
              });
              if (!finished) throw new Error('Incomplete answer stream');
            } else {
              // Existing backend processes remain compatible until restarted.
              run.finish(await upstream.json());
            }
          }
        } catch {
          if (!signal.aborted) run.error('Could not complete this answer. Please try again.');
          else if (!req.signal.aborted && !controller.signal.aborted) output.enqueue(encoder.encode(eventFrame({ type: 'RUN_ERROR', message: 'The request took too long. Please try again.' })));
        } finally { closed = true; clearInterval(heartbeat); try { output.close(); } catch {} }
      },
      cancel() { controller.abort(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(CHAT_API_INTERNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    // Forward the backend's own status/body as-is on success; on failure,
    // never relay its raw error text to the browser -- the backend can
    // include internal detail (stack fragments, DB error text) that
    // shouldn't reach an untrusted client, authenticated or not.
    if (!upstream.ok) {
      console.error('[api/chat] backend returned', upstream.status, text.slice(0, 500));
      return NextResponse.json({ error: 'Could not process that request. Please try again.' }, { status: 502 });
    }

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    console.error('[api/chat] request to backend failed:', aborted ? 'timed out' : error);
    return NextResponse.json(
      { error: aborted ? 'The request took too long. Please try again.' : 'Could not reach the chat backend.' },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
