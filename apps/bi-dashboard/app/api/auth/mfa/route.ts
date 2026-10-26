import { NextRequest, NextResponse } from 'next/server';
import { createSession, SESSION_COOKIE } from '@/lib/auth/session';
import { completePendingLogin } from '@/lib/auth/mfa';
import { audit } from '@/lib/access/access-db';

/** Second step of sign-in: the 6-digit code from the authenticator app. */
export async function POST(req: NextRequest) {
  const { ticket, code } = await req.json().catch(() => ({}));
  try {
    const userId = await completePendingLogin(String(ticket || ''), String(code || ''));
    const token = await createSession(userId);
    void audit(userId, 'login', 'two-step');
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === 'production' });
    return res;
  } catch (error) {
    void audit(null, 'login.code_failed', null);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Sign in again.' }, { status: 401 });
  }
}
