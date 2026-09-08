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

// Without ?limit, returns the full transcript (used by /chat?session=ID so a
// continued conversation has complete context). With ?limit, returns a page
// of the most recent messages -- optionally older than ?beforeId -- for the
// read-only Sessions transcript view, which loads a few exchanges at a time
// instead of the whole history at once.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ session: null, messages: [], hasMore: false }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();

  const [sessionRows] = await db.execute(
    'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const sessions = sessionRows as unknown[];
  if (!sessions.length) return NextResponse.json({ session: null, messages: [], hasMore: false });

  const limitParam = req.nextUrl.searchParams.get('limit');
  const beforeId = req.nextUrl.searchParams.get('beforeId');

  if (!limitParam) {
    const [messageRows] = await db.execute(
      'SELECT id, role, content, tables_used, created_at FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC',
      [id, user.id],
    );
    const messages = (messageRows as Array<{ tables_used: unknown }>).map((row) => ({
      ...row,
      tables_used: parseTablesUsed(row.tables_used),
    }));
    return NextResponse.json({ session: sessions[0], messages, hasMore: false });
  }

  const limit = Math.min(Math.max(Number(limitParam) || 10, 2), 200);

  const [pageRowsDesc] = beforeId
    ? await db.execute(
        'SELECT id, role, content, tables_used, created_at FROM chat_messages WHERE session_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        [id, user.id, beforeId, limit],
      )
    : await db.execute(
        'SELECT id, role, content, tables_used, created_at FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?',
        [id, user.id, limit],
      );

  const pageDesc = pageRowsDesc as Array<{ id: number; tables_used: unknown }>;
  const oldestIdInPage = pageDesc.length ? pageDesc[pageDesc.length - 1].id : null;

  let hasMore = false;
  if (oldestIdInPage !== null) {
    const [olderCountRows] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ? AND user_id = ? AND id < ?',
      [id, user.id, oldestIdInPage],
    );
    hasMore = Number((olderCountRows as Array<{ cnt: number }>)[0]?.cnt ?? 0) > 0;
  }

  const messages = pageDesc
    .slice()
    .reverse()
    .map((row) => ({ ...row, tables_used: parseTablesUsed(row.tables_used) }));

  return NextResponse.json({ session: sessions[0], messages, hasMore });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ deleted: false }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  await db.execute('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?', [id, user.id]);
  return NextResponse.json({ deleted: true });
}
