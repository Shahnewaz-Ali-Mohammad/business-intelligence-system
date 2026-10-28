import { NextRequest, NextResponse } from 'next/server';
import { openDesign } from '@/lib/designer/guard';
import { runSpec } from '@/lib/designer/engine';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Fresh data for every block of the saved report. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ designId: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  return NextResponse.json({ data: await runSpec(open.design.workspaceId, open.design.spec, open.guard.access) });
}
