import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { openWorkspaceForDesign } from '@/lib/designer/guard';
import { createDesign, listDesigns } from '@/lib/designer/store';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const open = await openWorkspaceForDesign(id); if (open.error) return open.error;
  return NextResponse.json({ designs: await listDesigns([id]) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const { id } = await params;
  const open = await openWorkspaceForDesign(id); if (open.error) return open.error;
  if (!(await getWorkspace(id))) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 404 });
  const body = z.object({ title: z.string().trim().max(200).optional() }).safeParse(await req.json().catch(() => ({})));
  const designId = await createDesign(id, open.guard.user.id, body.success ? body.data.title : undefined);
  return NextResponse.json({ id: designId });
}
