import { enterAccess } from '@/lib/access/data-scope.mjs';
import { audit } from '@/lib/access/access-db';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
// Full .xlsx export of a workspace answer: re-runs the exact approved tool
// and query plan behind the report and writes EVERY matching row, not just
// the rows shown in chat or on the current report page.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getTool, getSource } from '@/lib/tool-setup/store';
import { discoverDatabase, streamToolRows } from '@/lib/tool-setup/connectors.mjs';
import { getAppDb } from '@/lib/db/app-db';
import { exportHiddenColumns } from '@/lib/dashboard/column-visibility.mjs';
import { Readable } from 'node:stream';
import { startWorkbookExport, FILE_MARKER } from '@/lib/exports/streaming-export.mjs';

type SheetWriter = { add: (values: unknown[]) => Promise<void>; close: () => Promise<void> };
type WorkbookBuilder = { sheet: (name: string, headers: string[]) => SheetWriter };

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireAccess(['chat.use', 'reports.export']); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  void audit(user.id, 'export', new URL(req.url).pathname);
  const workspace = user && (await getWorkspace(id));
  if (!user || !canOpenWorkspace(guard.access)) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const toolId = sp.get('toolId');
  const query = sp.get('query') || '';
  const reportId = Number(sp.get('reportId'));
  if (!toolId || query.length > 20000 || !Number.isSafeInteger(reportId) || reportId <= 0) return NextResponse.json({ error: 'Save this report before exporting.' }, { status: 400 });
  try {
    const tool = await getTool(id, toolId);
    if (tool.status !== 'approved') throw new Error('Tool is not approved.');
    const [reports] = await getAppDb().execute('SELECT data FROM generated_reports WHERE id=? AND user_id=?', [reportId, user.id]);
    const report = (reports as { data: string | Record<string, unknown> }[])[0];
    const data = report && (typeof report.data === 'string' ? JSON.parse(report.data) : report.data);
    const saved = data?.workspaceToolAnswer as { workspaceId?: string; sourceId?: string; toolId?: string; query?: string } | undefined;
    if (!saved || saved.workspaceId !== id || saved.sourceId !== tool.source_id || saved.toolId !== toolId || saved.query !== query) return NextResponse.json({ error: 'The export does not match this saved report.' }, { status: 403 });
    const source = await getSource(id, tool.source_id);
    const catalog = await discoverDatabase(source.config);
    if (catalog.fingerprint !== tool.catalog_fingerprint) throw new Error('Schema changed.');
    // Streams every row straight into the workbook (and the stored copy for
    // the Exports page); nothing is held in memory, so any size exports.
    const hidden = exportHiddenColumns(sp);
    const safeName = tool.definition.name.replace(/[^a-z0-9_]+/gi, '-');
    const fileName = `${safeName}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const { response, done } = startWorkbookExport(async (book: WorkbookBuilder) => {
      let sheet: SheetWriter | null = null; let headers: string[] = [];
      await streamToolRows(source.config, tool.definition, catalog, { query }, async (batch: Record<string, unknown>[], fields: string[]) => {
        if (!sheet) { headers = fields.filter((key) => !hidden.includes(key)); sheet = book.sheet('Report', headers); }
        for (const row of batch) await sheet.add(headers.map((key) => row[key]));
      });
      if (!sheet) sheet = book.sheet('Report', ['No rows']);
      await sheet.close();
    });
    void done.then(({ fileId }) => getAppDb().execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [user.id, reportId, fileName, 'xlsx', FILE_MARKER + fileId])).catch((error) => console.error('[workspace export] failed:', error instanceof Error ? error.message : error));
    return new Response(Readable.toWeb(response) as ReadableStream, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[workspace export] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not build the export. Check the tool approval, schema and connection.' }, { status: 502 });
  }
}
