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
