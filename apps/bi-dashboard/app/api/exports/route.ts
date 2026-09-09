// Real export history: a row is written here only when a user actually
// clicks an Export button on a report. The /exports page reads this table
// and shows nothing until a real export has happened -- no seeded/fake data.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ exports: [] });

  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, report_id, file_name, format, created_at FROM report_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    [user.id],
  );
  return NextResponse.json({ exports: rows });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ logged: false, reason: 'not logged in' });

  try {
    const { reportId, fileName, format } = await req.json();
    if (typeof fileName !== 'string' || typeof format !== 'string') {
      return NextResponse.json({ error: 'fileName and format are required.' }, { status: 400 });
    }

    const db = getAppDb();
    await db.execute('INSERT INTO report_exports (user_id, report_id, file_name, format) VALUES (?, ?, ?, ?)', [
      user.id,
      typeof reportId === 'number' ? reportId : null,
      fileName,
      format,
    ]);
    return NextResponse.json({ logged: true });
  } catch (error) {
    console.error('export log failed:', error);
    return NextResponse.json({ error: 'Could not log export.' }, { status: 500 });
  }
}
