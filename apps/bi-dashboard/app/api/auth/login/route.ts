import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { verifyPassword, createSession, SESSION_COOKIE } from '@/lib/auth/session';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (typeof email !== 'string' || typeof password !== 'string') {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    const db = getAppDb();
    const [rows] = await db.execute(
      'SELECT id, email, password_hash, display_name FROM users WHERE email = ?',
      [email],
    );
    const list = rows as Array<{ id: number; email: string; password_hash: string; display_name: string | null }>;
    if (!list.length) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }

    const ok = await verifyPassword(password, list[0].password_hash);
    if (!ok) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }

    const token = await createSession(list[0].id);
    const res = NextResponse.json({
      user: { id: list[0].id, email: list[0].email, displayName: list[0].display_name },
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (error) {
    console.error('login failed:', error);
    return NextResponse.json({ error: 'Login failed. Please try again.' }, { status: 500 });
  }
}
