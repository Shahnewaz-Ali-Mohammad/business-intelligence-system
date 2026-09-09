import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ report: null }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, title, narrative, topic, chart_type, filters, tables_used, data, created_at FROM generated_reports WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const list = rows as Array<Record<string, unknown>>;
  const row = list[0];
  if (!row) return NextResponse.json({ report: null });

  // MariaDB stores JSON columns as plain TEXT, so mysql2 does not auto-parse
  // them -- normalize here so the client always gets real objects/arrays.
  const report = {
    ...row,
    filters: parseJsonColumn(row.filters),
    tables_used: parseJsonColumn(row.tables_used),
    data: parseJsonColumn(row.data),
  };
  return NextResponse.json({ report });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ updated: false, reason: 'not logged in' }, { status: 401 });

  const { id } = await params;
  try {
    const { title, narrative, topic, chartType, filters, tablesUsed, data } = await req.json();
    if (typeof title !== 'string' || typeof narrative !== 'string' || !data) {
      return NextResponse.json({ error: 'title, narrative, and data are required.' }, { status: 400 });
    }

    const db = getAppDb();
    const [result] = await db.execute(
      'UPDATE generated_reports SET title = ?, narrative = ?, topic = ?, chart_type = ?, filters = ?, tables_used = ?, data = ? WHERE id = ? AND user_id = ?',
      [
        title,
        narrative,
        typeof topic === 'string' ? topic : null,
        typeof chartType === 'string' ? chartType : null,
        filters ? JSON.stringify(filters) : null,
        tablesUsed ? JSON.stringify(tablesUsed) : null,
        JSON.stringify(data),
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
