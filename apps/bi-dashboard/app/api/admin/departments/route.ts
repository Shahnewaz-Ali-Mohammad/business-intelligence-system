import { enterAccess } from '@/lib/access/data-scope.mjs';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';
import { audit, listDepartments } from '@/lib/access/access-db';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

export async function GET() {
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const [counts] = await getAppDb().execute('SELECT department_id, COUNT(*) AS n FROM user_departments GROUP BY department_id');
  const members = new Map((counts as { department_id: number; n: number }[]).map((r) => [Number(r.department_id), Number(r.n)]));
  return NextResponse.json({ departments: (await listDepartments()).map((d) => ({ ...d, members: members.get(d.id) || 0 })) });
}

const Name = z.string().trim().min(1).max(120);
const Body = z.union([
  z.object({ action: z.literal('create'), name: Name, parentId: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal('update'), id: z.number().int().positive(), name: Name, parentId: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal('delete'), id: z.number().int().positive() }).strict(),
]);

/** Departments form a tree: a Manager of a department also covers the departments under it. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const body = parsed.data;
  const db = getAppDb();
  try {
    const all = await listDepartments();
    if (body.action !== 'delete' && body.parentId != null) {
      if (!all.some((d) => d.id === body.parentId)) throw new Error('Choose an existing parent department.');
      // A department cannot sit under itself or under one of its own sub-departments.
      if (body.action === 'update') {
        for (let at: number | null = body.parentId, depth = 0; at != null && depth < 50; depth++) {
          if (at === body.id) throw new Error('A department cannot be placed under itself or its own sub-department.');
          at = all.find((d) => d.id === at)?.parentId ?? null;
        }
      }
    }
    if (body.action === 'create') {
      await db.execute('INSERT INTO departments (name, parent_id) VALUES (?, ?)', [body.name, body.parentId]);
    } else if (body.action === 'update') {
      await db.execute('UPDATE departments SET name=?, parent_id=? WHERE id=?', [body.name, body.parentId, body.id]);
    } else {
      if (all.some((d) => d.parentId === body.id)) throw new Error('Move or delete its sub-departments first.');
      const [used] = await db.execute('SELECT COUNT(*) AS n FROM user_departments WHERE department_id=?', [body.id]);
      if (Number((used as { n: number }[])[0].n) > 0) throw new Error('People are assigned to this department. Move them first.');
      await db.execute('DELETE FROM departments WHERE id=?', [body.id]);
    }
    await audit(guard.user.id, `department.${body.action}d`, 'name' in body ? body.name : String(body.id));
    return NextResponse.json({ departments: await listDepartments() });
  } catch (error) {
    const duplicate = (error as { code?: string }).code === 'ER_DUP_ENTRY';
    return NextResponse.json({ error: duplicate ? 'A department with that name already exists.' : error instanceof Error && !/ER_|SQL/.test(error.message) ? error.message : 'Could not save.' }, { status: 400 });
  }
}
