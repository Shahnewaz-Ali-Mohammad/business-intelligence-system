import { NextResponse } from 'next/server';
import { requireAccess, denied } from '@/lib/access/guard';
import { allowedWorkspaces } from '@/lib/access/access-db';
import { designerReady, listDesigns } from '@/lib/designer/store';
import { listWorkspaces } from '@/lib/workspaces/workspaceDb';

export const runtime = 'nodejs';

/** Designed reports in every workspace the person can open. */
export async function GET() {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard;
  if (!(await designerReady())) return NextResponse.json({ designs: [], notInstalled: true });
  const allowed = await allowedWorkspaces(guard.access);
  const designs = await listDesigns(allowed === 'all' ? 'all' : [...allowed]);
  const names = new Map(((await listWorkspaces().catch(() => [])) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
  return NextResponse.json({ designs: designs.map((d) => ({ ...d, workspace: names.get(d.workspaceId) || d.workspaceId })) });
}
