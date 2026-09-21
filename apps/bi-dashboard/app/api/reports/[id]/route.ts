import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ report: null }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, title, narrative, topic, chart_type, filters, tables_used, data, chart_spec, created_at FROM generated_reports WHERE id = ? AND user_id = ?',
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
  const report = {
    ...row,
    filters: parseJsonColumn(row.filters),
    tables_used: parseJsonColumn(row.tables_used),
    data: parseJsonColumn(row.data),
    chart_spec: parseJsonColumn(row.chart_spec),
  };
  return NextResponse.json({ report });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
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
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ deleted: false, reason: 'not logged in' }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [result] = await db.execute('DELETE FROM generated_reports WHERE id = ? AND user_id = ?', [id, user.id]);
  const affected = (result as { affectedRows: number }).affectedRows;
  if (!affected) return NextResponse.json({ deleted: false }, { status: 404 });

  return NextResponse.json({ deleted: true });
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
