import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ export: null }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, file_name, format, file_content FROM report_exports WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) return NextResponse.json({ export: null });

  return NextResponse.json({ export: row });
}
