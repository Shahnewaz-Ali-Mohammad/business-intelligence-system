// Simple email + password auth: bcrypt-hashed passwords, opaque random
// session tokens stored in `bi_app.sessions` and handed to the browser as an
// httpOnly cookie. No third-party auth provider, per product decision.
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { getAppDb } from '@/lib/db/app-db';

export const SESSION_COOKIE = 'bi_session';
const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export type SessionUser = {
  id: number;
  email: string;
  displayName: string | null;
};

export async function createSession(userId: number): Promise<string> {
  const db = getAppDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

export async function destroySession(token: string): Promise<void> {
  const db = getAppDb();
  await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
}

export async function getUserFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const db = getAppDb();
  const [rows] = await db.execute(
    `SELECT u.id, u.email, u.display_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW()`,
    [token],
  );
  const list = rows as Array<{ id: number; email: string; display_name: string | null }>;
  if (!list.length) return null;
  return { id: list[0].id, email: list[0].email, displayName: list[0].display_name };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return getUserFromToken(token);
}
