import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
// Re-introspects the workspace's saved connection and asks the model to
// draft a candidate semantic model from it. Never auto-confirmed -- see
// confirm-model/route.ts, the only place that writes what the chat/query
// layer actually reads.
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, getConnection, saveDraftYaml } from '@/lib/workspaces/workspaceDb';
import { draftSemanticModel } from '@/lib/workspaces/draftSemanticModel';
import { introspectPostgres } from '../../../../../../bi-warehouse/src/introspection/introspectPostgres.mjs';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess('setup.manage');
  if (denied(guard)) return guard;
  const user = guard.user;
  const { id: workspaceId } = await params;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace || !canOpenWorkspace(guard.access)) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }

  const connection = await getConnection(workspaceId);
  if (!connection) {
    return NextResponse.json({ error: 'No connection saved for this workspace yet.' }, { status: 404 });
  }

  try {
    const introspection = await introspectPostgres(connection.connectionString);
    const draft = await draftSemanticModel(introspection);
    await saveDraftYaml(workspaceId, draft.yaml);
    return NextResponse.json({ yaml: draft.yaml, cubes: draft.cubes });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Draft generation failed' }, { status: 500 });
  }
}
