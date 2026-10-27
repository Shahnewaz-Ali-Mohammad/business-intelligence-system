import { enterAccess } from '@/lib/access/data-scope.mjs';
import { requireAccess, denied } from '@/lib/access/guard';
import { allowedWorkspaces } from '@/lib/access/access-db';
// Workspace list/create -- the entry point for onboarding a new customer
// database alongside the existing (hardcoded, untouched) ISP system. Every
// route under app/api/workspaces/* requires a signed-in user, same as the
// rest of the authenticated API surface (reports, exports, chat).
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { listWorkspaces, createWorkspace } from '@/lib/workspaces/workspaceDb';
import { getAppDb } from '@/lib/db/app-db';

const CreateWorkspaceSchema = z.object({ name: z.string().min(1).max(200) });

export async function GET() {
  const guard = await requireAccess();
  if (denied(guard)) return guard; enterAccess(guard.access);
  // Only the workspaces this person may open: their departments' workspaces
  // (CEO and admins: all). The original workspace is CEO only.
  const allowed = await allowedWorkspaces(guard.access);
  const workspaces = (await listWorkspaces()).filter((w) => (w.id === 'isp-default' ? guard.access.allData : allowed === 'all' || allowed.has(w.id)));
  let sources: { id: string; database_name: string; workspace_id: string }[] = [];
  try {
    const [rows] = await getAppDb().execute('SELECT src.id,src.database_name,srv.workspace_id FROM bi_tool_sources src JOIN bi_tool_servers srv ON srv.id=src.server_id JOIN workspaces w ON w.id=srv.workspace_id ORDER BY src.database_name,src.id');
    sources = rows as typeof sources;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  return NextResponse.json({ workspaces: workspaces.map((w) => ({ ...w, databases: sources.filter((s) => s.workspace_id === w.id).map((s) => ({ id: s.id, name: s.database_name })) })) });
}

export async function POST(req: NextRequest) {
  const guard = await requireAccess('setup.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const user = guard.user;
  const body = await req.json().catch(() => null);
  const parsed = CreateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const workspace = await createWorkspace(parsed.data.name, user.id);
  return NextResponse.json({ workspace }, { status: 201 });
}
