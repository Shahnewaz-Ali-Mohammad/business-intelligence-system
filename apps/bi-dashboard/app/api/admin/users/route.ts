import { enterAccess } from '@/lib/access/data-scope.mjs';
import { createHash, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';
import { audit, listDepartments } from '@/lib/access/access-db';
import { ROLES, ROLE_NAMES, validRoles } from '@/lib/access/permissions.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Users with their roles and departments, open invitations, and the role catalogue. */
export async function GET() {
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const db = getAppDb();
  const [users] = await db.execute(`SELECT u.id, u.email, u.display_name, u.created_at, (SELECT disabled_at FROM user_status WHERE user_id=u.id) AS disabled_at,
      (SELECT GROUP_CONCAT(r.role) FROM user_roles r WHERE r.user_id=u.id) AS roles,
      (SELECT GROUP_CONCAT(d.department_id) FROM user_departments d WHERE d.user_id=u.id) AS departments,
      (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id=u.id) AS last_sign_in,
      (SELECT enabled_at FROM user_mfa m WHERE m.user_id=u.id) AS mfa_at
    FROM users u ORDER BY disabled_at IS NOT NULL, u.email`);
  const [invites] = await db.execute('SELECT id, email, roles, department_ids, expires_at, created_at FROM invitations WHERE used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC');
  return NextResponse.json({
    users: (users as Record<string, unknown>[]).map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at, disabledAt: u.disabled_at, lastSignIn: u.last_sign_in, mfa: !!u.mfa_at, roles: u.roles ? String(u.roles).split(',') : [], departmentIds: u.departments ? String(u.departments).split(',').map(Number) : [] })),
    invitations: (invites as Record<string, unknown>[]).map((i) => ({ id: i.id, email: i.email, roles: parse(i.roles), departmentIds: parse(i.department_ids), expiresAt: i.expires_at })),
    roles: ROLE_NAMES.map((name) => ({ name, ...ROLES[name as keyof typeof ROLES] })),
    departments: await listDepartments(),
    me: guard.user.id,
  });
}

const Invite = z.object({ action: z.literal('invite'), email: z.string().trim().toLowerCase().email().max(255), roles: z.array(z.string()), departmentIds: z.array(z.number().int().positive()).max(50) }).strict();
const Update = z.object({ action: z.literal('update'), userId: z.number().int().positive(), roles: z.array(z.string()), departmentIds: z.array(z.number().int().positive()).max(50) }).strict();
const Disable = z.object({ action: z.enum(['disable', 'enable']), userId: z.number().int().positive() }).strict();
const Revoke = z.object({ action: z.literal('revokeInvite'), inviteId: z.number().int().positive() }).strict();
const ResetMfa = z.object({ action: z.literal('resetMfa'), userId: z.number().int().positive() }).strict();
const Body = z.union([Invite, Update, Disable, Revoke, ResetMfa]);

/** The admin's actions on people: invite, change roles/departments, disable, revoke an invitation. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const body = parsed.data;
  const me = guard.user.id;
  const db = await getAppDb().getConnection();
  try {
    await db.beginTransaction();
    const known = new Set((await listDepartments()).map((d) => d.id));
    if ('departmentIds' in body && body.departmentIds.some((id) => !known.has(id))) throw new Error('Choose existing departments.');
    if ('roles' in body) {
      if (!validRoles(body.roles)) throw new Error('Choose at least one valid role.');
      if (body.roles.some((r) => r === 'manager' || r === 'executive') && !body.departmentIds.length) throw new Error('Managers and Executives need at least one department.');
    }
    const adminsLeft = async (excluding: number) => {
      const [rows] = await db.execute("SELECT COUNT(*) AS n FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.role='admin' AND (SELECT disabled_at FROM user_status WHERE user_id=u.id) IS NULL AND u.id<>?", [excluding]);
      return Number((rows as { n: number }[])[0].n);
    };
    let result: Record<string, unknown> = { ok: true };
    if (body.action === 'invite') {
      const [taken] = await db.execute('SELECT id FROM users WHERE email=?', [body.email]);
      if ((taken as unknown[]).length) throw new Error('This person already has an account.');
      const token = randomBytes(32).toString('hex');
      await db.execute('INSERT INTO invitations (email, token_hash, roles, department_ids, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))', [body.email, createHash('sha256').update(token).digest('hex'), JSON.stringify(body.roles), JSON.stringify(body.departmentIds), me]);
      // Shown to the admin once, to send to the person; only its hash is stored.
      result = { inviteLink: `${new URL(req.url).origin}/register?invite=${token}`, expiresInDays: 7 };
      await audit(me, 'user.invited', body.email, { roles: body.roles, departmentIds: body.departmentIds });
    } else if (body.action === 'update') {
      if (body.userId === me && !body.roles.includes('admin') && (await adminsLeft(me)) === 0) throw new Error('You are the last admin; keep the Admin role or make someone else an admin first.');
      await db.execute('DELETE FROM user_roles WHERE user_id=?', [body.userId]);
      await db.execute('DELETE FROM user_departments WHERE user_id=?', [body.userId]);
      for (const role of body.roles) await db.execute('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', [body.userId, role]);
      for (const id of body.departmentIds) await db.execute('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)', [body.userId, id]);
      await audit(me, 'user.access_changed', String(body.userId), { roles: body.roles, departmentIds: body.departmentIds });
    } else if (body.action === 'disable' || body.action === 'enable') {
      if (body.action === 'disable' && body.userId === me) throw new Error('You cannot disable your own account.');
      await db.execute(`INSERT INTO user_status (user_id, disabled_at) VALUES (?, ${body.action === 'disable' ? 'NOW()' : 'NULL'}) ON DUPLICATE KEY UPDATE disabled_at=VALUES(disabled_at)`, [body.userId]);
      // Disabling signs the person out everywhere immediately.
      if (body.action === 'disable') await db.execute('DELETE FROM sessions WHERE user_id=?', [body.userId]);
      await audit(me, `user.${body.action}d`, String(body.userId));
    } else if (body.action === 'resetMfa') {
      // Lost phone: their two-step sign-in is removed and they set it up again; their sessions end.
      await db.execute('DELETE FROM user_mfa WHERE user_id=?', [body.userId]);
      await db.execute('DELETE FROM sessions WHERE user_id=?', [body.userId]);
      await audit(me, 'user.mfa_reset', String(body.userId));
    } else if (body.action === 'revokeInvite') {
      await db.execute('UPDATE invitations SET expires_at=NOW() WHERE id=? AND used_at IS NULL', [body.inviteId]);
      await audit(me, 'user.invite_revoked', String(body.inviteId));
    }
    await db.commit();
    return NextResponse.json(result);
  } catch (error) {
    await db.rollback();
    return NextResponse.json({ error: error instanceof Error && !/ER_|SQL/.test(error.message) ? error.message : 'Could not save.' }, { status: 400 });
  } finally { db.release(); }
}
