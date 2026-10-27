import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAccess, denied } from '@/lib/access/guard';
import { enterAccess } from '@/lib/access/data-scope.mjs';
import { audit, listDepartments, workspaceDepartments, setWorkspaceDepartments, workspaceAccessReady } from '@/lib/access/access-db';
import { listWorkspaces } from '@/lib/workspaces/workspaceDb';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

/** Every workspace with the departments that may open it. */
export async function GET() {
  const guard = await requireAccess('users.manage'); if (denied(guard)) return guard; enterAccess(guard.access);
  if (!(await workspaceAccessReady())) return NextResponse.json({ error: 'Run database/workspace-access-migration.sql once in phpMyAdmin (bi_app), then reload.', code: 'not_installed' }, { status: 503 });
  const assigned = await workspaceDepartments();
  return NextResponse.json({
    workspaces: (await listWorkspaces()).filter((w) => w.id !== 'isp-default').map((w) => ({ id: w.id, name: w.name, departmentIds: assigned.get(w.id) || [] })),
    departments: await listDepartments(),
  });
}

/** Gives a workspace to departments (replaces its list). */
export async function PUT(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const guard = await requireAccess('users.manage'); if (denied(guard)) return guard; enterAccess(guard.access);
  const parsed = z.object({ workspaceId: z.string().min(1).max(64), departmentIds: z.array(z.number().int().positive()).max(100) }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { workspaceId, departmentIds } = parsed.data;
  if (workspaceId === 'isp-default') return NextResponse.json({ error: 'The original workspace is CEO only.' }, { status: 400 });
  if (!(await listWorkspaces()).some((w) => w.id === workspaceId)) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  const known = new Set((await listDepartments()).map((d) => d.id));
  if (departmentIds.some((id) => !known.has(id))) return NextResponse.json({ error: 'Choose existing departments.' }, { status: 400 });
  await setWorkspaceDepartments(workspaceId, [...new Set(departmentIds)]);
  await audit(guard.user.id, 'workspace.access_changed', workspaceId, { departmentIds });
  return NextResponse.json({ ok: true });
}
