import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { hashPassword, createSession, SESSION_COOKIE } from '@/lib/auth/session';
import { ensureAccessSchema, audit } from '@/lib/access/access-db';
import { validRoles } from '@/lib/access/permissions.mjs';

// Accounts are created only from an admin's invitation. The very first
// account on a new installation becomes Admin + CEO so the system can be set up.
export async function POST(req: NextRequest) {
  try {
    const { email, password, displayName, invite } = await req.json();
    if (typeof password !== 'string' || password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return NextResponse.json({ error: 'Password must be at least 10 characters and include a letter and a number.' }, { status: 400 });
    }
    await ensureAccessSchema();
    const db = await getAppDb().getConnection();
    try {
      await db.beginTransaction();
      const [[{ users }]] = (await db.query('SELECT COUNT(*) AS users FROM users')) as unknown as [[{ users: number }]];
      let roles: string[]; let departmentIds: number[]; let accountEmail: string; let inviteId: number | null = null;
      if (Number(users) === 0) {
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
        roles = ['admin', 'ceo']; departmentIds = []; accountEmail = email.trim().toLowerCase();
      } else {
        if (typeof invite !== 'string' || !/^[a-f0-9]{64}$/.test(invite)) throw new Error('Accounts are created by invitation. Ask your admin for an invite link.');
        const [rows] = await db.execute('SELECT id, email, roles, department_ids FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at > NOW() FOR UPDATE', [createHash('sha256').update(invite).digest('hex')]);
        const row = (rows as { id: number; email: string; roles: unknown; department_ids: unknown }[])[0];
        if (!row) throw new Error('This invite link is invalid, used or expired. Ask your admin for a new one.');
        const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
        roles = parse(row.roles); departmentIds = parse(row.department_ids); accountEmail = row.email; inviteId = row.id;
        if (!validRoles(roles)) throw new Error('This invitation has no valid role. Ask your admin for a new one.');
      }
      const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [accountEmail]);
      if ((existing as unknown[]).length) throw new Error('An account with that email already exists. Sign in instead.');
      const [result] = await db.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [accountEmail, await hashPassword(password), typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 120) : null]);
      const userId = (result as { insertId: number }).insertId;
      for (const role of roles) await db.execute('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', [userId, role]);
      for (const department of departmentIds) await db.execute('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)', [userId, Number(department)]);
      if (inviteId) await db.execute('UPDATE invitations SET used_at = NOW() WHERE id = ?', [inviteId]);
      await db.commit();
      void audit(userId, 'account.created', accountEmail, { roles, departmentIds, invited: !!inviteId });
      const token = await createSession(userId);
      const res = NextResponse.json({ user: { id: userId, email: accountEmail, displayName: displayName || null } });
      res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === 'production' });
      return res;
    } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
  } catch (error) {
    const message = error instanceof Error && !/ER_|SQL/i.test(error.message) ? error.message : 'Registration failed. Please try again.';
    if (message === 'Registration failed. Please try again.') console.error('register failed:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** What the sign-up page needs to show: first-time setup or an invitation. */
export async function GET(req: NextRequest) {
  await ensureAccessSchema();
  const [[{ users }]] = (await getAppDb().query('SELECT COUNT(*) AS users FROM users')) as unknown as [[{ users: number }]];
  const invite = req.nextUrl.searchParams.get('invite');
  if (Number(users) === 0) return NextResponse.json({ mode: 'first-admin' });
  if (!invite || !/^[a-f0-9]{64}$/.test(invite)) return NextResponse.json({ mode: 'invite-required' });
  const [rows] = await getAppDb().execute('SELECT email FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at > NOW()', [createHash('sha256').update(invite).digest('hex')]);
  const row = (rows as { email: string }[])[0];
  return NextResponse.json(row ? { mode: 'invite', email: row.email } : { mode: 'invite-invalid' });
}
