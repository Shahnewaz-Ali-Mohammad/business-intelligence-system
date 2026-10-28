import { NextResponse } from 'next/server';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { enterAccess } from '@/lib/access/data-scope.mjs';
import { designerReady, getDesign } from './store';

const notReady = () => NextResponse.json({ error: 'The Report Designer is not installed yet. Import database/report-designer-migration.sql in phpMyAdmin.' }, { status: 503 });

/** Anyone who can chat in the report's workspace can open and design it. */
export async function openDesign(rawId: string) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return { error: guard };
  enterAccess(guard.access);
  if (!(await designerReady())) return { error: notReady() };
  const id = Number(rawId);
  const design = Number.isInteger(id) && id > 0 ? await getDesign(id) : null;
  if (!design || !(await canOpenWorkspace(guard.access, design.workspaceId))) return { error: NextResponse.json({ error: 'Report not found.' }, { status: 404 }) };
  return { guard, design };
}

export async function openWorkspaceForDesign(workspaceId: string) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return { error: guard };
  enterAccess(guard.access);
  if (!(await designerReady())) return { error: notReady() };
  if (!(await canOpenWorkspace(guard.access, workspaceId))) return { error: NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 }) };
  return { guard };
}
