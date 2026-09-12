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
const REQUEST_TIMEOUT_MS = 60_000;

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
