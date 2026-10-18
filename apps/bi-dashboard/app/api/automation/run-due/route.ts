import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { runDueReports } from '@/lib/schedules/run-scheduled';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Constant-time check of the automation key sent by n8n. */
function authorized(req: NextRequest) {
  const expected = process.env.AUTOMATION_API_KEY || '';
  const given = req.headers.get('x-automation-key') || '';
  if (expected.length < 24 || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Called by the n8n schedule (every few minutes). Runs every saved report
 * whose scheduled time has arrived and returns what happened.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  try { return NextResponse.json(await runDueReports()); }
  catch (error) {
    console.error('[automation] scheduled run failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Scheduled run failed.' }, { status: 500 });
  }
}
