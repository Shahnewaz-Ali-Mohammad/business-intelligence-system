import { NextRequest, NextResponse } from 'next/server';
import { warehouseContext, connectionFingerprint } from '@/lib/workspaces/warehouse';
import { getWorkspace, getSemanticModel } from '@/lib/workspaces/workspaceDb';
import { decryptConnectionString } from '@/lib/workspaces/secrets';
import { verifyWorkspaceToken } from '../../../../../bi-warehouse/src/services/workspaceCube.mjs';
import { cubeYaml, parseModel } from '../../../../../bi-warehouse/src/semantic/warehouseModel.mjs';
import { connectionConfig } from '../../../../../bi-warehouse/src/introspection/discoverWarehouse.mjs';

export const runtime = 'nodejs';
export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    const claims = verifyWorkspaceToken(token);
    if (claims.purpose !== 'bridge') throw new Error('Invalid purpose.');
    let model, url;
    if (claims.preview) {
      const workspace = await getWorkspace(claims.workspaceId);
      if (workspace?.ownerUserId !== claims.ownerUserId) throw new Error('Forbidden.');
      const saved = await getSemanticModel(claims.workspaceId);
      const draft = JSON.parse(saved?.draftYaml || '{}');
      model = parseModel(draft.previewYaml);
      url = decryptConnectionString(draft.encryptedConnection);
      if (model.fingerprint !== claims.modelVersion || model.connectionFingerprint !== connectionFingerprint(url)) throw new Error('Stale preview.');
    } else {
      const context = await warehouseContext(claims.workspaceId, claims.ownerUserId, claims.modelVersion);
      model = context.model; url = context.connectionString;
    }
    const connection = connectionConfig(url);
    return NextResponse.json({ yaml: cubeYaml(model), connection }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Warehouse access denied.' }, { status: 403 });
  }
}
