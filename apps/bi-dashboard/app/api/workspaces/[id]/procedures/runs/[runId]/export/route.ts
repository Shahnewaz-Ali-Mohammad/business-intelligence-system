import { NextRequest, NextResponse } from 'next/server';
import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { resultRows } from '@/lib/tool-setup/procedure-run-store.mjs';
import { procedureRunStatus } from '@/lib/tool-setup/procedure-runs';

export const runtime = 'nodejs';
export const maxDuration = 3600;
const SHEET_ROWS = 1_048_575; // Excel's limit per sheet, minus the header row

/**
 * Streams every row of every result table into an .xlsx file. Rows are read
 * from stored results and written as they go, so any size result exports
 * without being held in memory. A table above Excel's per-sheet limit
 * continues on further sheets.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const user = await getCurrentUser();
  const workspace = user && await getWorkspace(id);
  if (!user || workspace?.ownerUserId !== user.id) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
  const run = await procedureRunStatus(id, runId);
  if (!run || String(run.userId) !== String(user.id)) return NextResponse.json({ error: 'Report run unavailable.' }, { status: 404 });
  if (run.status !== 'completed') return NextResponse.json({ error: 'The report is still running.' }, { status: 409 });
  let hidden: Record<string, string[]> = {};
  try { hidden = JSON.parse(req.nextUrl.searchParams.get('hidden') || '{}'); } catch { hidden = {}; }

  const output = new PassThrough();
  const fileName = `${String(run.procedure?.name || 'report').replace(/[^\w.-]+/g, '-')}.xlsx`;
  (async () => {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useSharedStrings: false, useStyles: false });
    let total = 0; void total;
    for (const [index, set] of (run.resultSets as { columns: string[]; rowCount: number }[]).entries()) {
      const columns = set.columns.filter((c) => !(hidden[String(index)] || []).includes(c));
      let part = 1; let inSheet = 0;
      const newSheet = () => { const sheet = workbook.addWorksheet(`Result ${index + 1}${part > 1 ? ` (${part})` : ''}`.slice(0, 31)); sheet.addRow(columns).commit(); return sheet; };
      let sheet = newSheet();
      for await (const row of resultRows(id, runId, index)) {
        if (inSheet === SHEET_ROWS) { await sheet.commit(); part++; inSheet = 0; sheet = newSheet(); }
        sheet.addRow(columns.map((c) => (row as Record<string, unknown>)[c] ?? '')).commit();
        inSheet++; total++;
      }
      await sheet.commit();
    }
    const outputs = workbook.addWorksheet('Output parameters');
    outputs.addRow(['Parameter', 'Value']).commit();
    for (const [name, value] of Object.entries(run.output || {})) outputs.addRow([name, value == null ? '' : String(value)]).commit();
    outputs.addRow(['Return code', run.returnValue ?? '']).commit();
    await outputs.commit();
    await workbook.commit();
  })().catch((error) => output.destroy(error));
  return new NextResponse(Readable.toWeb(output) as ReadableStream, {
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fileName}"` },
  });
}
