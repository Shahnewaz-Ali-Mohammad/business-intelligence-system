import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { readRun, resultRows } from '@/lib/tool-setup/procedure-run-store.mjs';
import { aggregateProcedureGraph } from '@/lib/tool-setup/procedure-graph.mjs';
export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    const user = await getCurrentUser(); const workspace = user && await getWorkspace(id);
    if (!user || workspace?.ownerUserId !== user.id) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
    const run = await readRun(id, runId);
    if (!run || String(run.userId) !== String(user.id)) return NextResponse.json({ error: 'Report unavailable.' }, { status: 404 });
    if (run.status !== 'completed') return NextResponse.json({ error: 'Wait for the report to finish.' }, { status: 409 });
    const query = req.nextUrl.searchParams; const index = Number(query.get('set'));
    const set = Number.isSafeInteger(index) && index >= 0 && run.resultSets[index];
    if (!set) return NextResponse.json({ error: 'Invalid result table.' }, { status: 400 });
    return NextResponse.json(await aggregateProcedureGraph(resultRows(id, runId, index), set.columns, { category: query.get('category') || '', metric: query.get('metric') || null, aggregation: query.get('aggregation') || 'sum', signal: req.signal }));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Graph failed.' }, { status: 400 }); }
}
