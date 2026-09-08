import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { hashPassword, createSession, SESSION_COOKIE } from '@/lib/auth/session';

export async function POST(req: NextRequest) {
  try {
    const { email, password, displayName } = await req.json();

    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    const db = getAppDb();
    const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if ((existing as unknown[]).length) {
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const [result] = await db.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      [email, passwordHash, displayName || null],
    );
    const userId = (result as { insertId: number }).insertId;

    const token = await createSession(userId);
    const res = NextResponse.json({
      user: { id: userId, email, displayName: displayName || null },
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (error) {
    console.error('register failed:', error);
    return NextResponse.json({ error: 'Registration failed. Please try again.' }, { status: 500 });
  }
}
