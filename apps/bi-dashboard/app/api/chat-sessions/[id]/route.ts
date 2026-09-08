import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

function parseTablesUsed(value: unknown): string[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ session: null, messages: [] }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();

  const [sessionRows] = await db.execute(
    'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const sessions = sessionRows as unknown[];
  if (!sessions.length) return NextResponse.json({ session: null, messages: [] });

  const [messageRows] = await db.execute(
    'SELECT id, role, content, tables_used, created_at FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC',
    [id, user.id],
  );
  const messages = (messageRows as Array<{ tables_used: unknown }>).map((row) => ({
    ...row,
    tables_used: parseTablesUsed(row.tables_used),
  }));

  return NextResponse.json({ session: sessions[0], messages });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ deleted: false }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  await db.execute('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?', [id, user.id]);
  return NextResponse.json({ deleted: true });
}
