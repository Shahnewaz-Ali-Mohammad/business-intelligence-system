import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, getConnection, getSemanticModel, saveDraftYaml } from '@/lib/workspaces/workspaceDb';
import { decryptConnectionString, encryptConnectionString } from '@/lib/workspaces/secrets';
import { activateWarehouse, stageWarehousePreview, configuredWarehouseUrl, connectionFingerprint } from '@/lib/workspaces/warehouse';
import { discoverWarehouse, validateSelectedTables } from '../../../../../../bi-warehouse/src/introspection/discoverWarehouse.mjs';
import { buildWarehouseModel, parseModel, serializeModel } from '../../../../../../bi-warehouse/src/semantic/warehouseModel.mjs';
import { workspaceCubeLoad } from '../../../../../../bi-warehouse/src/services/workspaceCube.mjs';

export const runtime = 'nodejs';
export const maxDuration = 180;
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('discover'), connectionString: z.string().max(2000).optional(), useExistingWarehouse: z.boolean().optional(), schemas: z.array(z.string().min(1).max(63)).max(10).default([]) }),
  z.object({ action: z.literal('activate'), selectedTables: z.array(z.string()).min(1).max(250), approvedJoins: z.array(z.string()).max(250).default([]), draftFingerprint: z.string() }),
]);
async function owner(id: string) {
  const user = await getCurrentUser();
  const workspace = user && await getWorkspace(id);
  return user && workspace?.ownerUserId === user.id ? { user, workspace } : null;
}
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await owner(id)) return NextResponse.json({ error: 'Warehouse not found.' }, { status: 404 });
  const saved = await getSemanticModel(id);
  let model = null, discovery = null, usesExistingWarehouse = false;
  try { if (saved?.confirmedYaml) model = parseModel(saved.confirmedYaml); } catch {}
  try { const draft = JSON.parse(saved?.draftYaml || '{}'); discovery = draft.discovery || null; usesExistingWarehouse = draft.usesExistingWarehouse === true; } catch {}
  return NextResponse.json({ ready: !!model, usesExistingWarehouse: saved ? usesExistingWarehouse : true, model: model ? { fingerprint: model.fingerprint, selectedTables: model.selectedTables, approvedJoins: model.approvedJoins, warnings: model.warnings } : null, discovery });
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await owner(id);
  if (!access) return NextResponse.json({ error: 'Warehouse not found.' }, { status: 404 });
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid warehouse setup request.' }, { status: 400 });
  let stage = 'connection and schema discovery';
  try {
    const body = parsed.data;
    const saved = await getSemanticModel(id);
    let draft: { encryptedConnection?: string; discovery?: Awaited<ReturnType<typeof discoverWarehouse>>; previewYaml?: string; usesExistingWarehouse?: boolean } = {};
    try { draft = JSON.parse(saved?.draftYaml || '{}'); } catch {}
    if (body.action === 'discover') {
      const url = body.useExistingWarehouse ? configuredWarehouseUrl() : body.connectionString?.trim() || (draft.encryptedConnection ? decryptConnectionString(draft.encryptedConnection) : (await getConnection(id))?.connectionString);
      if (!url) return NextResponse.json({ error: 'Enter a connection URL or choose the existing warehouse.' }, { status: 400 });
      const discovery = await discoverWarehouse(url, body.schemas);
      discovery.connectionFingerprint = connectionFingerprint(url);
      await saveDraftYaml(id, JSON.stringify({ encryptedConnection: encryptConnectionString(url), discovery, usesExistingWarehouse: body.useExistingWarehouse === true }));
      return NextResponse.json({ discovery });
    }
    if (!draft.encryptedConnection || !draft.discovery?.tables.length || draft.discovery.fingerprint !== body.draftFingerprint) return NextResponse.json({ error: 'The setup changed. Discover the schema again before activation.' }, { status: 409 });
    const url = decryptConnectionString(draft.encryptedConnection);
    const latest = await discoverWarehouse(url, draft.discovery.schemas);
    if (latest.fingerprint !== draft.discovery.fingerprint) return NextResponse.json({ error: 'The schema changed. Discover it again before activation.' }, { status: 409 });
    latest.connectionFingerprint = connectionFingerprint(url);
    stage = 'approved model generation';
    const model = buildWarehouseModel(latest, id, body.selectedTables, body.approvedJoins);
    stage = 'selected table access';
    await validateSelectedTables(url, model);
    const yaml = serializeModel(model);
    const previewDraft = JSON.stringify({ ...draft, previewYaml: yaml });
    stage = 'preview staging';
    await stageWarehousePreview(id, saved!.draftYaml!, previewDraft);
    // Compile and execute a bounded test with preview-only authorization before
    // atomically replacing the live connection and model.
    const context = { model, ownerUserId: access.user.id, preview: true };
    stage = 'Cube model compilation';
    await workspaceCubeLoad(context, null, 'meta');
    stage = 'Cube connection test';
    await workspaceCubeLoad(context, { measures: [`${model.cubes[0].name}.record_count`] });
    stage = 'activation commit';
    await activateWarehouse(id, url, yaml, previewDraft);
    return NextResponse.json({ ready: true, warnings: model.warnings, chatUrl: `/chat?workspace=${id}`, tableCount: model.cubes.length });
  } catch (error) {
    // Driver errors may contain host/user information. Do not relay raw errors.
    console.error('[warehouse setup]', stage, error instanceof Error ? error.name : 'Error');
    return NextResponse.json({ error: `Could not validate this warehouse at ${stage}. Check the connection, approved host, schema access, and Cube service. The previous active model has not been replaced.` }, { status: 400 });
  }
}
