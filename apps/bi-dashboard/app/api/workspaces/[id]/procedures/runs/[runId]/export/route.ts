import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getAppDb } from '@/lib/db/app-db';
import { resultRows } from '@/lib/tool-setup/procedure-run-store.mjs';
import { procedureRunStatus } from '@/lib/tool-setup/procedure-runs';
import { startWorkbookExport, FILE_MARKER } from '@/lib/exports/streaming-export.mjs';
import { startPdfExport } from '@/lib/exports/pdf-export.mjs';

export const runtime = 'nodejs';
export const maxDuration = 3600;
type SheetWriter = { add: (values: unknown[]) => Promise<void>; close: () => Promise<void> };
type WorkbookBuilder = { sheet: (name: string, headers: string[]) => SheetWriter };

/**
 * Excel export of a saved procedure report: every row of every result table,
 * streamed from the stored result (same export flow and history as other
 * reports). Hidden columns are left out per result table.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const user = await getCurrentUser();
  const workspace = user && await getWorkspace(id);
  if (!user || workspace?.ownerUserId !== user.id) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
  const reportId = Number(req.nextUrl.searchParams.get('reportId'));
  if (!Number.isSafeInteger(reportId) || reportId <= 0) return NextResponse.json({ error: 'Save this report before exporting.' }, { status: 400 });
  const [reports] = await getAppDb().execute("SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.workspaceToolAnswer.procedure.runId')) AS runId FROM generated_reports WHERE id=? AND user_id=?", [reportId, user.id]);
  if ((reports as { runId: string | null }[])[0]?.runId !== runId) return NextResponse.json({ error: 'The export does not match this saved report.' }, { status: 403 });
  const run = await procedureRunStatus(id, runId);
  if (!run || String(run.userId) !== String(user.id)) return NextResponse.json({ error: 'Report run unavailable.' }, { status: 404 });
  if (run.status !== 'completed') return NextResponse.json({ error: 'The report is still running.' }, { status: 409 });
  let hidden: Record<string, string[]> = {};
  try { hidden = JSON.parse(req.nextUrl.searchParams.get('hidden') || '{}'); } catch { hidden = {}; }
  if (!hidden || typeof hidden !== 'object' || Array.isArray(hidden) || JSON.stringify(hidden).length > 200000 || Object.values(hidden).some(columns => !Array.isArray(columns) || columns.some(column => typeof column !== 'string'))) return NextResponse.json({ error: 'Invalid column settings.' }, { status: 400 });
  const format = req.nextUrl.searchParams.get('format') || 'xlsx';
  if (!['xlsx', 'pdf'].includes(format)) return NextResponse.json({ error: 'Invalid export format.' }, { status: 400 });

  const fileName = `${String(run.procedure?.name || 'report').replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.${format}`;
  const sets = run.resultSets as { columns: string[]; rowCount: number }[];
  const { response, done } = format === 'pdf' ? startPdfExport({ title: `${run.procedure.schema}.${run.procedure.name}`, narrative: run.narrative || '', tables: sets.map((set, index) => ({ columns: set.columns.filter(column => !(hidden[String(index)] || []).includes(column)), rows: () => resultRows(id, runId, index) })), output: run.output || {}, returnValue: run.returnValue }) : startWorkbookExport(async (book: WorkbookBuilder) => {
    for (const [index, set] of sets.entries()) {
      const columns = set.columns.filter((c) => !(hidden[String(index)] || []).includes(c));
      const sheet = book.sheet(sets.length > 1 ? `Result ${index + 1}` : 'Report', columns);
      for await (const row of resultRows(id, runId, index)) await sheet.add(columns.map((c) => (row as Record<string, unknown>)[c]));
      await sheet.close();
    }
    const outputs = book.sheet('Output parameters', ['Parameter', 'Value']);
    for (const [name, value] of Object.entries(run.output || {})) await outputs.add([name, value]);
    await outputs.add(['Return code', run.returnValue ?? '']);
    await outputs.close();
  });
  void done.then(({ fileId }) => getAppDb().execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [user.id, reportId, fileName, format, FILE_MARKER + fileId])).catch((error) => console.error('[procedure export] failed:', error instanceof Error ? error.message : error));
  return new NextResponse(Readable.toWeb(response) as ReadableStream, {
    headers: { 'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store' },
  });
}
