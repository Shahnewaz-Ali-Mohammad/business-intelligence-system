import { NextRequest, NextResponse } from 'next/server';
import { openDesign } from '@/lib/designer/guard';
import { runBlock, runSpec } from '@/lib/designer/engine';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Fresh data for every block of the saved report. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ designId: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  const body = await req.json().catch(() => ({})) as { blockId?: string };
  if (body.blockId) {
    const block = open.design.spec.blocks.find((b) => b.id === body.blockId);
    if (!block) return NextResponse.json({ error: 'Block not found.' }, { status: 404 });
    const data = await (await import('@/lib/access/data-scope.mjs')).runWithAccess(open.guard.access, () => runBlock(open.design.workspaceId, block));
    return NextResponse.json({ blockId: block.id, data });
  }
  return NextResponse.json({ data: await runSpec(open.design.workspaceId, open.design.spec, open.guard.access) });
}
