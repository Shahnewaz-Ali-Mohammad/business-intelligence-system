// Human-in-the-loop confirmation: the review screen sends back the
// (possibly edited) YAML, which becomes the workspace's confirmed_yaml --
// the only field any future query/chat layer for this workspace is ever
// built from. draft_yaml is left untouched so re-running the AI draft
// never silently overwrites a human decision.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, confirmYaml } from '@/lib/workspaces/workspaceDb';

const BodySchema = z.object({ confirmedYaml: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const { id: workspaceId } = await params;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.ownerUserId !== user.id) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await confirmYaml(workspaceId, parsed.data.confirmedYaml);

  // Materialize the confirmed model as a real file the self-hosted Cube
  // instance reads directly (see cube/README.md) -- Cube's own file-based
  // model loader picks up cube/model/workspaces/*.yml with no code of ours
  // involved in reading it.
  const cubeModelDir = path.join(process.cwd(), '..', '..', 'cube', 'model', 'workspaces');
  await fs.mkdir(cubeModelDir, { recursive: true });
  await fs.writeFile(path.join(cubeModelDir, `${workspaceId}.yml`), parsed.data.confirmedYaml, 'utf-8');

  return NextResponse.json({ ok: true });
}
