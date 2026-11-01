import { NextResponse } from 'next/server';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { enterAccess } from '@/lib/access/data-scope.mjs';
import { designerReady, getDesign } from './store';
import type { DesignPermissions } from './store';

const notReady = () => NextResponse.json({ error: 'Designed report tables or sharing columns are missing. Apply database/report-designer-migration.sql and run `npm run db:report-sharing` with a MySQL schema admin account.' }, { status: 503 });

/** Workspace access is always required. Publishing can only narrow access inside that workspace. */
export async function openDesign(rawId: string) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return { error: guard };
  enterAccess(guard.access);
  if (!(await designerReady())) return { error: notReady() };
  const id = Number(rawId);
  const design = Number.isInteger(id) && id > 0 ? await getDesign(id) : null;
  if (!design || !(await canOpenWorkspace(guard.access, design.workspaceId))) return { error: NextResponse.json({ error: 'Report not found.' }, { status: 404 }) };
  const isOwner = Number(design.createdBy) === guard.user.id;
  const allowedByShare = design.published && (design.shareScope === 'workspace' || (design.shareScope === 'selected' && (design.audience.users.includes(guard.user.id) || guard.access.roles.some((role) => design.audience.roles.includes(role)) || guard.access.departmentIds.some((departmentId) => design.audience.departments.includes(departmentId)))));
  if (!isOwner && !allowedByShare) return { error: NextResponse.json({ error: 'This report has not been shared with you.' }, { status: 404 }) };
  const permissions: DesignPermissions = {
    canEdit: isOwner && guard.access.permissions.includes('reports.save'),
    canManageShare: isOwner && guard.access.permissions.includes('reports.save'),
    canExport: design.allowExport && guard.access.permissions.includes('reports.export'),
  };
  return { guard, design, permissions };
}

export async function openWorkspaceForDesign(workspaceId: string) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return { error: guard };
  enterAccess(guard.access);
  if (!(await designerReady())) return { error: notReady() };
  if (!(await canOpenWorkspace(guard.access, workspaceId))) return { error: NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 }) };
  return { guard };
}
