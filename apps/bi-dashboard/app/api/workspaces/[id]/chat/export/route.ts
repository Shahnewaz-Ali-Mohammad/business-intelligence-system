// Full .xlsx export of a workspace answer: re-runs the exact approved tool
// and query plan behind the report and writes EVERY matching row, not just
// the rows shown in chat or on the current report page.
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getTool, getSource } from '@/lib/tool-setup/store';
import { discoverDatabase, streamToolRows } from '@/lib/tool-setup/connectors.mjs';
import { getAppDb } from '@/lib/db/app-db';
import { exportHiddenColumns } from '@/lib/dashboard/column-visibility.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const workspace = user && (await getWorkspace(id));
  if (!user || workspace?.ownerUserId !== user.id) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
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
    let headers: string[] = [];
    const rows: (string | number)[][] = [];
    await streamToolRows(source.config, tool.definition, catalog, { query }, (batch: Record<string, unknown>[], fields: string[]) => {
      if (!headers.length) headers = fields.filter(key => !exportHiddenColumns(sp).includes(key));
      for (const row of batch) {
        rows.push(headers.map((key) => {
          const value = row[key];
          if (value == null) return '';
          if (typeof value === 'number') return value;
          if (value instanceof Date) return value.toISOString();
          return String(value);
        }));
      }
    });
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const safeName = tool.definition.name.replace(/[^a-z0-9_]+/gi, '-');
    const fileName = `${safeName}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    await getAppDb().execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [user.id, reportId, fileName, 'xlsx', buffer.toString('base64')]);
    return new Response(new Uint8Array(buffer), {
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
