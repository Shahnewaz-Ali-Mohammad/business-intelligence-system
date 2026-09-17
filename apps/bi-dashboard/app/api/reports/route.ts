// Persists generated report/artifact pages (chat intent "create_new_page")
// for the logged-in user.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

const PAGE_SIZE = 6; // standardized with Sessions list (was 5)

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ reports: [], total: 0 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getAppDb();
  const [countRows] = await db.execute('SELECT COUNT(*) AS total FROM generated_reports WHERE user_id = ?', [
    user.id,
  ]);
  const total = Number((countRows as Array<{ total: number }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    'SELECT id, title, narrative, topic, chart_type, created_at FROM generated_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [user.id, PAGE_SIZE, offset],
  );

  return NextResponse.json({ reports: rows, total, page, pageSize: PAGE_SIZE });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ saved: false, reason: 'not logged in' });

  try {
    const { title, narrative, topic, chartType, filters, tablesUsed, data } = await req.json();
    if (typeof title !== 'string' || typeof narrative !== 'string' || !data) {
      return NextResponse.json({ error: 'title, narrative, and data are required.' }, { status: 400 });
    }

    const db = getAppDb();
    const [result] = await db.execute(
      'INSERT INTO generated_reports (user_id, title, narrative, topic, chart_type, filters, tables_used, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        user.id,
        title,
        narrative,
        typeof topic === 'string' ? topic : null,
        typeof chartType === 'string' ? chartType : null,
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
