// Saves one chat message into a specific conversation (chat_sessions row).
// Session grouping lives in /api/chat-sessions; this endpoint only appends.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ saved: false, reason: 'not logged in' });

  try {
    const { sessionId, role, content, tablesUsed } = await req.json();
    if (role !== 'user' && role !== 'assistant') {
      return NextResponse.json({ error: 'role must be "user" or "assistant".' }, { status: 400 });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return NextResponse.json({ error: 'content is required.' }, { status: 400 });
    }
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
    }

    const db = getAppDb();

    // Only write into a session that belongs to this user.
    const [sessionRows] = await db.execute(
      'SELECT id, title FROM chat_sessions WHERE id = ? AND user_id = ?',
      [sessionId, user.id],
    );
    const sessions = sessionRows as Array<{ id: number; title: string }>;
    if (!sessions.length) {
      return NextResponse.json({ error: 'Unknown session.' }, { status: 404 });
    }

    await db.execute(
      'INSERT INTO chat_messages (user_id, session_id, role, content, tables_used) VALUES (?, ?, ?, ?, ?)',
      [user.id, sessionId, role, content, tablesUsed ? JSON.stringify(tablesUsed) : null],
    );

    // Auto-title the conversation from the first user message.
    if (role === 'user' && sessions[0].title === 'New conversation') {
      const title = content.trim().slice(0, 80);
      await db.execute('UPDATE chat_sessions SET title = ? WHERE id = ?', [title, sessionId]);
    } else {
      // Keep updated_at fresh even when the DB's ON UPDATE trigger is skipped
      // by a plain UPDATE-less path (kept explicit for clarity/portability).
      await db.execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
    }

    return NextResponse.json({ saved: true });
  } catch (error) {
    console.error('chat-history save failed:', error);
    return NextResponse.json({ error: 'Could not save message.' }, { status: 500 });
  }
}
