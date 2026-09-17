// Chat "sessions" are real conversations: a title, a set of paired
// user/assistant messages, and a timestamp. Listing here powers the
// Sessions page; creating one happens once per new chat in the UI.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

// FIX 2026-09-17: this used to return every session in one shot (capped at
// a flat LIMIT 100 with no page controls), unlike /api/reports which was
// already paged. Standardized to the same page-size (6) and the same
// page/total contract as reports, so both list pages share one pagination
// pattern instead of two different behaviors.
const PAGE_SIZE = 6;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ sessions: [], total: 0, page: 1 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getAppDb();
  const [countRows] = await db.execute('SELECT COUNT(*) AS total FROM chat_sessions WHERE user_id = ?', [
    user.id,
  ]);
  const total = Number((countRows as Array<{ total: number }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    `SELECT
       s.id,
       s.title,
       s.created_at,
       s.updated_at,
       COUNT(m.id) AS message_count,
       (
         SELECT content FROM chat_messages
         WHERE session_id = s.id AND role = 'user'
         ORDER BY created_at DESC LIMIT 1
       ) AS last_question,
       (
         SELECT content FROM chat_messages
         WHERE session_id = s.id AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1
       ) AS last_answer
     FROM chat_sessions s
     LEFT JOIN chat_messages m ON m.session_id = s.id
     WHERE s.user_id = ?
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT ? OFFSET ?`,
    [user.id, PAGE_SIZE, offset],
  );
  return NextResponse.json({ sessions: rows, total, page, pageSize: PAGE_SIZE });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 255) : 'New conversation';

  const db = getAppDb();
  const [result] = await db.execute('INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)', [
    user.id,
    title,
  ]);
  const id = (result as { insertId: number }).insertId;
  return NextResponse.json({ id, title });
}
