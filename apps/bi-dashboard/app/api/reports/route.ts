// Persists generated report/artifact pages (chat intent "create_new_page")
// for the logged-in user.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ reports: [] });

  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, title, narrative, filters, tables_used, data, created_at FROM generated_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    [user.id],
  );

  // MariaDB stores JSON columns as plain TEXT, so mysql2 does not auto-parse
  // them -- normalize here so the client always gets real objects/arrays.
  const reports = (rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    filters: parseJsonColumn(row.filters),
    tables_used: parseJsonColumn(row.tables_used),
    data: parseJsonColumn(row.data),
  }));

  return NextResponse.json({ reports });
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

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ saved: false, reason: 'not logged in' });

  try {
    const { title, narrative, filters, tablesUsed, data } = await req.json();
    if (typeof title !== 'string' || typeof narrative !== 'string' || !data) {
      return NextResponse.json({ error: 'title, narrative, and data are required.' }, { status: 400 });
    }

    const db = getAppDb();
    const [result] = await db.execute(
      'INSERT INTO generated_reports (user_id, title, narrative, filters, tables_used, data) VALUES (?, ?, ?, ?, ?, ?)',
      [
        user.id,
        title,
        narrative,
        filters ? JSON.stringify(filters) : null,
        tablesUsed ? JSON.stringify(tablesUsed) : null,
        JSON.stringify(data),
      ],
    );
    return NextResponse.json({ saved: true, id: (result as { insertId: number }).insertId });
  } catch (error) {
    console.error('report save failed:', error);
    return NextResponse.json({ error: 'Could not save report.' }, { status: 500 });
  }
}
