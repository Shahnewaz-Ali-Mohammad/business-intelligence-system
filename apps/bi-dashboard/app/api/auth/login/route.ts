import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { verifyPassword, createSession, SESSION_COOKIE } from '@/lib/auth/session';
import { disabledAtSql, audit, accessReady } from '@/lib/access/access-db';
import { mfaEnabled, createPendingLogin } from '@/lib/auth/mfa';

// Repeated wrong passwords lock the account (and the address trying) for a
// while, so passwords cannot be guessed by brute force.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();
const recent = (key: string) => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW_MS);
const fail = (key: string) => failures.set(key, [...recent(key), Date.now()]);

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (typeof email !== 'string' || typeof password !== 'string') {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }
    const account = email.trim().toLowerCase();
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
    const keys = [`email:${account}`, `ip:${ip}`];
    if (keys.some((key) => recent(key).length >= MAX_FAILURES)) {
      return NextResponse.json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' }, { status: 429 });
    }

    const [rows] = await getAppDb().execute(
      `SELECT u.id, u.email, u.password_hash, u.display_name, ${await disabledAtSql()} AS disabled_at FROM users u WHERE u.email = ?`,
      [account],
    );
    const list = rows as Array<{ id: number; email: string; password_hash: string; display_name: string | null; disabled_at: unknown }>;
    const ok = list.length > 0 && (await verifyPassword(password, list[0].password_hash));
    if (!ok) {
      keys.forEach(fail);
      void audit(list[0]?.id ?? null, 'login.failed', account);
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }
    if (list[0].disabled_at) {
      void audit(list[0].id, 'login.blocked', account, { reason: 'disabled' });
      return NextResponse.json({ error: 'This account is disabled. Contact your admin.' }, { status: 403 });
    }
    keys.forEach((key) => failures.delete(key));
    // Accounts with two-step sign-in get a short ticket, not a session, until the code is entered.
    if ((await accessReady()) && (await mfaEnabled(list[0].id))) {
      return NextResponse.json({ mfa: true, ticket: await createPendingLogin(list[0].id) });
    }

    const token = await createSession(list[0].id);
    void audit(list[0].id, 'login', account);
    const res = NextResponse.json({
      user: { id: list[0].id, email: list[0].email, displayName: list[0].display_name },
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      secure: process.env.NODE_ENV === 'production',
    });
    return res;
  } catch (error) {
    console.error('login failed:', error);
    return NextResponse.json({ error: 'Login failed. Please try again.' }, { status: 500 });
  }
}
