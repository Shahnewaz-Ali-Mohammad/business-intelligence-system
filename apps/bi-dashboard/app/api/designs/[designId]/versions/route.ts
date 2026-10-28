import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { openDesign } from '@/lib/designer/guard';
import { getVersion, listVersions, saveDesign } from '@/lib/designer/store';
import { runSpec } from '@/lib/designer/engine';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ designId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  return NextResponse.json({ versions: await listVersions(open.design.id) });
}

/** Restores an earlier version (the current one is kept as a version too). */
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  const body = z.object({ versionId: z.number().int().positive() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const spec = await getVersion(open.design.id, body.data.versionId);
  if (!spec) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });
  await saveDesign(open.design.id, open.guard.user.id, spec, null, 'Restored an earlier version');
  return NextResponse.json({ spec, data: await runSpec(open.design.workspaceId, spec, open.guard.access) });
}
