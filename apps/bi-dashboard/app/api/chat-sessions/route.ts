import { requireAccess, denied } from '@/lib/access/guard';
// Chat "sessions" are real conversations: a title, a set of paired
// user/assistant messages, and a timestamp. Listing here powers the
// Sessions page; creating one happens once per new chat in the UI.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';

// FIX 2026-09-17: this used to return every session in one shot (capped at
// a flat LIMIT 100 with no page controls), unlike /api/reports which was
// already paged. Standardized to the same page-size (6) and the same
// page/total contract as reports, so both list pages share one pagination
// pattern instead of two different behaviors.
const PAGE_SIZE = 6;

export async function GET(req: NextRequest) {
  const guard = await requireAccess(); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ sessions: [], total: 0, page: 1 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getAppDb();
  const workspace = req.nextUrl.searchParams.get('workspace');
  const source = req.nextUrl.searchParams.get('source');
  const clauses = ['s.user_id = ?'];
  const bindings: (string | number)[] = [user.id];
  if (!workspace || workspace === 'isp-default') clauses.push("(s.warehouse_id IS NULL OR s.warehouse_id='isp-default')");
  else { clauses.push('s.warehouse_id = ?'); bindings.push(workspace); }
  if (source) {
    clauses.push("EXISTS(SELECT 1 FROM chat_messages sm WHERE sm.session_id=s.id AND JSON_UNQUOTE(JSON_EXTRACT(sm.report_data, '$.workspaceToolAnswer.sourceId'))=?)");
    bindings.push(source);
  }
  const where = clauses.join(' AND ');
  const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM chat_sessions s WHERE ${where}`, bindings);
  const total = Number((countRows as Array<{ total: number }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    `SELECT
       s.id,
       s.title,
       s.warehouse_id,
       EXISTS(SELECT 1 FROM chat_messages tm WHERE tm.session_id=s.id AND JSON_EXTRACT(tm.report_data, '$.workspaceToolAnswer') IS NOT NULL) AS tool_chat,
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
     WHERE ${where}
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...bindings, PAGE_SIZE, offset],
  );
  return NextResponse.json({ sessions: rows, total, page, pageSize: PAGE_SIZE });
}

export async function POST(req: NextRequest) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 255) : 'New conversation';
  const warehouseId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
  if (warehouseId) {
    const workspace = warehouseId === 'isp-default' ? null : await getWorkspace(warehouseId);
    if (warehouseId !== 'isp-default' && !workspace) return NextResponse.json({ error: 'Workspace is not available.' }, { status: 400 });
  }

  const db = getAppDb();
  const [result] = await db.execute('INSERT INTO chat_sessions (user_id, title, warehouse_id) VALUES (?, ?, ?)', [
    user.id,
    title,
    warehouseId,
  ]);
  const id = (result as { insertId: number }).insertId;
  return NextResponse.json({ id, title });
}
