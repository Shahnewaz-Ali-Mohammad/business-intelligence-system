// Chat "sessions" are real conversations: a title, a set of paired
// user/assistant messages, and a timestamp. Listing here powers the
// Sessions page; creating one happens once per new chat in the UI.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ sessions: [] });

  const db = getAppDb();
  const [rows] = await db.execute(
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
     LIMIT 100`,
    [user.id],
  );
  return NextResponse.json({ sessions: rows });
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
