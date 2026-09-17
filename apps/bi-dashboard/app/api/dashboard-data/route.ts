// Proxy in front of the internal read-only backend's GET /api/dashboard
// (readonly-api.mjs, port 4100). The Home dashboard used to call that port
// directly from the browser via a NEXT_PUBLIC_ env var; that port is now
// bound to localhost only, so this route is what makes it reachable from
// the browser at all. The Home dashboard itself is intentionally not
// login-gated (unlike Reports/Exports) -- that's an existing product
// decision this route preserves, not something to silently change. A
// lightweight IP-based rate limit is still applied since this triggers a
// real database query per call.
import { NextRequest, NextResponse } from 'next/server';

const DASHBOARD_API_INTERNAL_URL = process.env.DASHBOARD_API_INTERNAL_URL ?? 'http://localhost:4100/api/dashboard';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (requestLog.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function GET(req: NextRequest) {
  const clientKey = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  if (isRateLimited(clientKey)) {
    return NextResponse.json({ error: 'Too many requests -- please wait a moment.' }, { status: 429 });
  }

  const days = req.nextUrl.searchParams.get('days');
  const region = req.nextUrl.searchParams.get('region');
  // PERF FIX 2026-09-17: pass an optional `topic` through so a caller that
  // only needs one real breakdown (e.g. the background chat-page fetch,
  // which only ever reads kpi labels + static chartSources + top POPs)
  // doesn't pay for every breakdown in the system -- see readonly-api.mjs's
  // own comment on this.
  const topic = req.nextUrl.searchParams.get('topic');
  const upstreamUrl = new URL(DASHBOARD_API_INTERNAL_URL);
  if (days) upstreamUrl.searchParams.set('days', days);
  if (region) upstreamUrl.searchParams.set('region', region);
  if (topic) upstreamUrl.searchParams.set('topic', topic);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl.toString(), { cache: 'no-store', signal: controller.signal });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[api/dashboard-data] backend returned', upstream.status, text.slice(0, 500));
      return NextResponse.json({ error: 'Could not load dashboard data.' }, { status: 502 });
    }
    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    console.error('[api/dashboard-data] request to backend failed:', aborted ? 'timed out' : error);
    return NextResponse.json(
      { error: aborted ? 'The request took too long. Please try again.' : 'Could not reach the dashboard backend.' },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
