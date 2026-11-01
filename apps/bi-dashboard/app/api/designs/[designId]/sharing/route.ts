import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { accessReady, listDepartments } from '@/lib/access/access-db';
import { ROLES, ROLE_NAMES } from '@/lib/access/permissions.mjs';
import { openDesign } from '@/lib/designer/guard';
import { updateShare, type ShareAudience, type ShareScope } from '@/lib/designer/store';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { audit } from '@/lib/access/access-db';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ designId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  if (!open.permissions.canManageShare) return NextResponse.json({ error: 'Only the report owner can manage sharing.' }, { status: 403 });
  const db = getAppDb();
  const activeOnly = await accessReady() ? 'WHERE (SELECT disabled_at FROM user_status WHERE user_id=u.id) IS NULL' : '';
  const [rows] = await db.execute(`SELECT u.id, u.email, u.display_name FROM users u ${activeOnly} ORDER BY COALESCE(u.display_name, u.email), u.email`);
  const users = rows as { id: number; email: string; display_name: string | null }[];
  return NextResponse.json({
    share: { published: open.design.published, scope: open.design.shareScope, allowExport: open.design.allowExport, audience: open.design.audience },
    options: {
      users: users.filter((u) => Number(u.id) !== open.guard.user.id).map((u) => ({ id: Number(u.id), label: u.display_name ? `${u.display_name} (${u.email})` : u.email })),
      roles: ROLE_NAMES.filter((role) => role !== 'admin').map((id) => ({ id, label: ROLES[id as keyof typeof ROLES].label })),
      departments: await listDepartments(),
    },
  });
}

const Body = z.object({
  published: z.boolean(),
  scope: z.enum(['private', 'workspace', 'selected']),
  allowExport: z.boolean(),
  audience: z.object({
    users: z.array(z.number().int().positive()).max(200),
    roles: z.array(z.string()).max(10),
    departments: z.array(z.number().int().positive()).max(100),
  }).strict(),
}).strict();

export async function PUT(req: NextRequest, { params }: Ctx) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  if (!open.permissions.canManageShare) return NextResponse.json({ error: 'Only the report owner can manage sharing.' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Choose valid sharing settings.' }, { status: 400 });
  const body = parsed.data;
  if (new Set(body.audience.users).size !== body.audience.users.length || new Set(body.audience.roles).size !== body.audience.roles.length || new Set(body.audience.departments).size !== body.audience.departments.length)
    return NextResponse.json({ error: 'Remove duplicate audience selections.' }, { status: 400 });
  if (body.audience.roles.some((role) => !ROLE_NAMES.includes(role))) return NextResponse.json({ error: 'Choose valid roles.' }, { status: 400 });
  const departments = new Set((await listDepartments()).map((d) => d.id));
  if (body.audience.departments.some((id) => !departments.has(id))) return NextResponse.json({ error: 'Choose valid departments.' }, { status: 400 });
  const userIds = new Set<number>();
  if (body.audience.users.length) {
    const activeOnly = await accessReady() ? 'AND (SELECT disabled_at FROM user_status WHERE user_id=users.id) IS NULL' : '';
    const [rows] = await getAppDb().execute(`SELECT id FROM users WHERE id IN (${body.audience.users.map(() => '?').join(',')}) ${activeOnly}`, body.audience.users);
    for (const user of rows as { id: number }[]) userIds.add(Number(user.id));
  }
  if (body.audience.users.some((id) => !userIds.has(id))) return NextResponse.json({ error: 'Choose existing users.' }, { status: 400 });
  const scope: ShareScope = body.published ? body.scope : 'private';
  if (body.published && scope === 'private') return NextResponse.json({ error: 'Choose a sharing audience before publishing.' }, { status: 400 });
  if (body.published && scope === 'selected' && !body.audience.users.length && !body.audience.roles.length && !body.audience.departments.length)
    return NextResponse.json({ error: 'Select at least one person, role, or department.' }, { status: 400 });
  const audience: ShareAudience = body.audience;
  await updateShare(open.design.id, open.guard.user.id, { published: body.published, scope, allowExport: body.allowExport, audience });
  await audit(open.guard.user.id, body.published ? 'designed_report.published' : 'designed_report.unpublished', String(open.design.id), { scope, allowExport: body.allowExport }).catch(() => {});
  return NextResponse.json({ ok: true, share: { published: body.published, scope, allowExport: body.allowExport, audience } });
}
