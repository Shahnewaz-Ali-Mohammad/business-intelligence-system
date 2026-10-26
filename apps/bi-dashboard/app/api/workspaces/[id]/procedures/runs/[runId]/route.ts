import { NextRequest, NextResponse } from 'next/server';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { readResultPage, requestCancel, PAGE_ROWS } from '@/lib/tool-setup/procedure-run-store.mjs';
import { procedureRunStatus } from '@/lib/tool-setup/procedure-runs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

async function ownedRun(id: string, runId: string) {
  const guard = await requireAccess('procedures.run');
  if (denied(guard)) return null;
  const user = guard.user;
  const workspace = await getWorkspace(id);
  if (!workspace || !canOpenWorkspace(guard.access)) return null;
  const run = await procedureRunStatus(id, runId);
  return run && String(run.userId) === String(user.id) ? run : null;
}

/** Run status, result-table sizes and summaries; with ?set=&page= also that page of rows. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    const run = await ownedRun(id, runId);
    if (!run) return NextResponse.json({ error: 'Report run unavailable.' }, { status: 404 });
    const set = Number(req.nextUrl.searchParams.get('set'));
    const page = Number(req.nextUrl.searchParams.get('page'));
    const rows = Number.isInteger(set) && set >= 0 && page >= 1 && set < run.resultSets.length ? await readResultPage(id, runId, set, page) : undefined;
    return NextResponse.json({
      id: run.id, status: run.status, progress: run.progress, error: run.error, narrative: run.narrative,
      resultSets: run.resultSets, summaries: run.summaries, output: run.output, returnValue: run.returnValue, messages: run.messages,
      pageSize: PAGE_ROWS, ...(rows ? { rows } : {}),
    });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Report run unavailable.' }, { status: 400 }); }
}

/** Cancels a running report. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const { id, runId } = await params;
  const run = await ownedRun(id, runId);
  if (!run) return NextResponse.json({ error: 'Report run unavailable.' }, { status: 404 });
  if (['queued', 'running'].includes(run.status)) await requestCancel(id, runId);
  return NextResponse.json({ cancelling: true });
}
