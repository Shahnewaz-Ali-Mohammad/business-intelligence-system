import { enterAccess } from '@/lib/access/data-scope.mjs';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getTool, getSource, listSetup } from '@/lib/tool-setup/store';
import { recordGraphPlan } from '@/lib/tool-setup/graph-plan.mjs';
import { discoverDatabase, executeTool } from '@/lib/tool-setup/connectors.mjs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  const workspace = user && await getWorkspace(id);
  if (!user || !(await canOpenWorkspace(guard.access, id))) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
  const parsed = z.object({ toolId: z.string().uuid(), query: z.string().max(20000), groupBy: z.string().min(1).max(500) }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid graph request.' }, { status: 400 });
  try {
    const tool = await getTool(id, parsed.data.toolId);
    if (tool.status !== 'approved' || tool.definition.mode !== 'rows' || !tool.definition.capabilities) throw new Error('Unavailable');
    const source = await getSource(id, tool.source_id);
    const catalog = await discoverDatabase(source.config);
    if (catalog.fingerprint !== tool.catalog_fingerprint) throw new Error('Schema changed');
    const query = recordGraphPlan(tool.definition, catalog, source.config.dialect, parsed.data.query, parsed.data.groupBy);
    const setup = await listSetup(id);
    const aggregate = setup.tools.find((t) => t.sourceId === tool.source_id && t.status === 'approved' && t.definition.mode === 'aggregate' && t.definition.base === tool.definition.base && t.definition.capabilities);
    if (!aggregate) throw new Error('Approve analytics tool first');
    const approvedAggregate = await getTool(id, aggregate.id);
    if (approvedAggregate.status !== 'approved' || approvedAggregate.catalog_fingerprint !== catalog.fingerprint) throw new Error('Approval or schema changed');
    const result = await executeTool(source.config, approvedAggregate.definition, catalog, { query }, 100);
    return NextResponse.json({ ...result, category: parsed.data.groupBy, metric: 'record_count', scope: 'Counts across all matching records; up to 100 result groups shown.' });
  } catch { return NextResponse.json({ error: 'Could not generate this graph. Test and approve the matching analytics tool and check its allowed fields and relationships.' }, { status: 409 }); }
}
