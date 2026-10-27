import { canOpenWorkspace } from '@/lib/access/access-db';
import { enterAccess } from '@/lib/access/data-scope.mjs';
import { requireAccess, denied } from '@/lib/access/guard';
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess(); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  if (!user) return NextResponse.json({ report: null }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, title, narrative, topic, chart_type, filters, tables_used, data, chart_spec, source_session_id, created_at FROM generated_reports WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const list = rows as Array<Record<string, unknown>>;
  const row = list[0];
  if (!row) return NextResponse.json({ report: null });

  // MariaDB stores JSON columns as plain TEXT, so mysql2 does not auto-parse
  // them -- normalize here so the client always gets real objects/arrays.
  // chart_spec is NULL for a report saved (or never edited) before this
  // column existed -- the page falls back to deriving a default chart from
  // `data` itself in that case, so a null here is expected, not an error.
  // Reports follow workspace access: a saved report from a workspace the
  // person can no longer open is not shown.
  const saved = parseJsonColumn(row.data) as { workspaceToolAnswer?: { workspaceId?: string } } | null;
  if (!(await canOpenWorkspace(guard.access, saved?.workspaceToolAnswer?.workspaceId || 'isp-default'))) return NextResponse.json({ report: null, error: 'You no longer have access to this report\u2019s workspace.' }, { status: 403 });
  const report = {
    ...row,
    filters: parseJsonColumn(row.filters),
    tables_used: parseJsonColumn(row.tables_used),
    data: parseJsonColumn(row.data),
    chart_spec: parseJsonColumn(row.chart_spec),
  };

  // Other reports saved from the SAME real chat session -- shown as
  // "Other reports from this chat" instead of a maintained parent/child
  // version tree, since the real conversation (not a copy of it) is the
  // actual source of truth for how these reports relate to each other.
  let siblingReports: Array<{ id: number; title: string; created_at: string }> = [];
  const sourceSessionId = row.source_session_id as number | null;
  if (sourceSessionId) {
    const [siblingRows] = await db.execute(
      'SELECT id, title, created_at FROM generated_reports WHERE source_session_id = ? AND user_id = ? AND id != ? ORDER BY created_at DESC',
      [sourceSessionId, user.id, id],
    );
    siblingReports = siblingRows as Array<{ id: number; title: string; created_at: string }>;
  }

  return NextResponse.json({ report, siblingReports });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess(); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  if (!user) return NextResponse.json({ updated: false, reason: 'not logged in' }, { status: 401 });

  const { id } = await params;
  try {
    const { title, narrative, topic, chartType, filters, tablesUsed, data, chartSpec } = await req.json();
    if (typeof title !== 'string' || typeof narrative !== 'string' || !data) {
      return NextResponse.json({ error: 'title, narrative, and data are required.' }, { status: 400 });
    }

    const db = getAppDb();
    const [result] = await db.execute(
      'UPDATE generated_reports SET title = ?, narrative = ?, topic = ?, chart_type = ?, filters = ?, tables_used = ?, data = ?, chart_spec = ? WHERE id = ? AND user_id = ?',
      [
        title,
        narrative,
        typeof topic === 'string' ? topic : null,
        typeof chartType === 'string' ? chartType : null,
        filters ? JSON.stringify(filters) : null,
        tablesUsed ? JSON.stringify(tablesUsed) : null,
        JSON.stringify(data),
        // This endpoint is a full replace (same as every other field
        // above, e.g. `data` is required on every call) -- a caller that
        // wants to keep the existing chart must send the report's current
        // chartSpec back, same as it must send back the current data.
        // Only the report detail page's "Save chart" action calls this
        // today, and it always round-trips the full report it just read.
        chartSpec ? JSON.stringify(chartSpec) : null,
        id,
        user.id,
      ],
    );
    const affected = (result as { affectedRows: number }).affectedRows;
    if (!affected) return NextResponse.json({ updated: false }, { status: 404 });

    return NextResponse.json({ updated: true });
  } catch (error) {
    console.error('report update failed:', error);
    return NextResponse.json({ error: 'Could not update report.' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess(); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  if (!user) return NextResponse.json({ deleted: false, reason: 'not logged in' }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [result] = await db.execute('DELETE FROM generated_reports WHERE id = ? AND user_id = ?', [id, user.id]);
  const affected = (result as { affectedRows: number }).affectedRows;
  if (!affected) return NextResponse.json({ deleted: false }, { status: 404 });

  return NextResponse.json({ deleted: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess(); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  if (!user) return NextResponse.json({ error: 'Sign in to save graph settings.' }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (body && Object.hasOwn(body, 'hiddenColumns')) {
    if (!Array.isArray(body.hiddenColumns) || body.hiddenColumns.length > 2000 || body.hiddenColumns.some((key: unknown) => typeof key !== 'string' || key.length > 1000)) return NextResponse.json({ error: 'Invalid column settings.' }, { status: 400 });
    if (!Object.hasOwn(body, 'chartSpec')) {
      if (Object.hasOwn(body, 'hiddenResultColumns')) {
        const settings = body.hiddenResultColumns;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 200000 || Object.entries(settings).some(([key, value]) => !/^\d{1,3}$/.test(key) || Number(key) >= 200 || !Array.isArray(value) || value.length > 2000 || value.some((column: unknown) => typeof column !== 'string' || column.length > 1000)) || !Number.isInteger(body.procedureActiveResult) || body.procedureActiveResult < 0 || body.procedureActiveResult >= 200) return NextResponse.json({ error: 'Invalid result-table settings.' }, { status: 400 });
        const graphs = body.procedureGraphs || {};
        if (typeof graphs !== 'object' || Array.isArray(graphs) || JSON.stringify(graphs).length > 250000) return NextResponse.json({ error: 'Invalid graph settings.' }, { status: 400 });
        const [result] = await getAppDb().execute("UPDATE generated_reports SET data=JSON_SET(data, '$.workspaceToolAnswer.hiddenColumns', JSON_EXTRACT(?, '$'), '$.workspaceToolAnswer.hiddenResultColumns', JSON_EXTRACT(?, '$'), '$.workspaceToolAnswer.procedureActiveResult', ?, '$.workspaceToolAnswer.procedureGraphs', JSON_EXTRACT(?, '$'), '$.workspaceToolAnswer.graphVisible', JSON_EXTRACT(?, '$')) WHERE id=? AND user_id=?", [JSON.stringify(body.hiddenColumns), JSON.stringify(settings), body.procedureActiveResult, JSON.stringify(graphs), JSON.stringify(body.graphVisible === true), id, user.id]);
        return (result as { affectedRows: number }).affectedRows ? NextResponse.json({ updated: true }) : NextResponse.json({ error: 'Report not found.' }, { status: 404 });
      }
      const [result] = await getAppDb().execute("UPDATE generated_reports SET data=JSON_SET(data, '$.hiddenColumns', JSON_EXTRACT(?, '$'), '$.workspaceToolAnswer.hiddenColumns', JSON_EXTRACT(?, '$')) WHERE id=? AND user_id=?", [JSON.stringify(body.hiddenColumns), JSON.stringify(body.hiddenColumns), id, user.id]);
      return (result as { affectedRows: number }).affectedRows ? NextResponse.json({ updated: true }) : NextResponse.json({ error: 'Report not found.' }, { status: 404 });
    }
  }
  const spec = body?.chartSpec;
  if (spec !== null && (!spec || typeof spec !== 'object' || Array.isArray(spec) || JSON.stringify(spec).length > 20000)) return NextResponse.json({ error: 'Invalid graph settings.' }, { status: 400 });
  const [result] = body?.hiddenColumns
    ? await getAppDb().execute("UPDATE generated_reports SET chart_spec=?, data=JSON_SET(data, '$.hiddenColumns', JSON_EXTRACT(?, '$')) WHERE id=? AND user_id=?", [spec ? JSON.stringify(spec) : null, JSON.stringify(body.hiddenColumns), id, user.id])
    : await getAppDb().execute('UPDATE generated_reports SET chart_spec=? WHERE id=? AND user_id=?', [spec ? JSON.stringify(spec) : null, id, user.id]);
  return (result as { affectedRows: number }).affectedRows ? NextResponse.json({ updated: true }) : NextResponse.json({ error: 'Report not found.' }, { status: 404 });
}

function parseJsonColumn(value: unknown): unknown {
  if (value == null || typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}
