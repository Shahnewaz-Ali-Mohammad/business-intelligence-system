import { NextRequest, NextResponse } from 'next/server';
import { openDesign } from '@/lib/designer/guard';
import { deleteDesign, saveDesign } from '@/lib/designer/store';
import { SpecSchema } from '@/lib/designer/spec';
import { validateBlocks } from '@/lib/designer/engine';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { audit } from '@/lib/access/access-db';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ designId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  const workspace = await getWorkspace(open.design.workspaceId);
  const design = open.permissions.canManageShare ? open.design : { ...open.design, messages: [], audience: { users: [], roles: [], departments: [] } };
  return NextResponse.json({ design, permissions: open.permissions, workspace: workspace ? { id: workspace.id, name: workspace.name } : null });
}

/** Saves a hand edit (reorder, resize, retitle, undo). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  if (!open.permissions.canEdit) return NextResponse.json({ error: 'Only the report owner can edit this report.' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const spec = SpecSchema.safeParse(body?.spec);
  if (!spec.success) return NextResponse.json({ error: 'Invalid report.' }, { status: 400 });
  // Every data block is checked again against the approved tools.
  const errors = await validateBlocks(open.design.workspaceId, spec.data.blocks);
  if (errors.length) return NextResponse.json({ error: 'A block uses data that is not approved.' }, { status: 400 });
  const safe = spec.data;
  await saveDesign(open.design.id, open.guard.user.id, safe, null, String(body?.note || 'Edited by hand'));
  return NextResponse.json({ spec: safe });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  if (!open.permissions.canEdit) return NextResponse.json({ error: 'Only the report owner can delete this report.' }, { status: 403 });
  await deleteDesign(open.design.id);
  await audit(open.guard.user.id, 'designed_report.delete', String(open.design.id), { title: open.design.title }).catch(() => {});
  return NextResponse.json({ ok: true });
}
