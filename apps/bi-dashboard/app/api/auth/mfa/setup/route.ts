import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { accessReady, loadAccess, audit } from '@/lib/access/access-db';
import { startSetup, finishSetup, turnOff, mfaEnabled, mfaRequiredFor } from '@/lib/auth/mfa';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

// Reached before two-step sign-in is set up, so it checks the session itself
// (requireAccess would send people who must set it up back here).
async function signedIn(req?: NextRequest) {
  if (req && !isSameOriginRequest(req)) return null;
  const user = await getCurrentUser();
  if (!user || !(await accessReady())) return null;
  return user;
}

/** Whether it is on; with ?start=1 a new key to add to the authenticator app. */
export async function GET(req: NextRequest) {
  if (!(await accessReady())) return NextResponse.json({ error: 'Two-step sign-in becomes available once roles are installed (npm run db:access).' }, { status: 503 });
  const user = await signedIn();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  const enabled = await mfaEnabled(user.id);
  const required = mfaRequiredFor((await loadAccess(user.id)).roles);
  if (enabled || req.nextUrl.searchParams.get('start') !== '1') return NextResponse.json({ enabled, required });
  return NextResponse.json({ enabled, required, ...(await startSetup(user.id, user.email)) });
}

/** Turns it on with the first code from the app. */
export async function POST(req: NextRequest) {
  const user = await signedIn(req);
  if (!user) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  const { code } = await req.json().catch(() => ({}));
  try { await finishSetup(user.id, String(code || '')); void audit(user.id, 'mfa.enabled', user.email); return NextResponse.json({ enabled: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not turn it on.' }, { status: 400 }); }
}

/** Turns it off (not allowed for roles that must use it). */
export async function DELETE(req: NextRequest) {
  const user = await signedIn(req);
  if (!user) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (mfaRequiredFor((await loadAccess(user.id)).roles)) return NextResponse.json({ error: 'Your role must use two-step sign-in.' }, { status: 403 });
  const { code } = await req.json().catch(() => ({}));
  try { await turnOff(user.id, String(code || '')); void audit(user.id, 'mfa.disabled', user.email); return NextResponse.json({ enabled: false }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not turn it off.' }, { status: 400 }); }
}
