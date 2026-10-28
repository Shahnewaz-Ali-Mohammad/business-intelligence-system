import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';
import { audit } from '@/lib/access/access-db';

const Create = z.object({ subject: z.string().trim().min(3).max(240), body: z.string().trim().min(1).max(20000), language: z.string().max(20).optional(), workspaceId: z.string().max(64).optional() });
export async function GET() {
  const guard = await requireAccess('support.use'); if (denied(guard)) return guard;
  const [rows] = await getAppDb().execute(`SELECT t.id,t.subject,t.status,t.priority,t.requester_user_id,t.assigned_to,t.language,t.ai_summary,t.created_at,t.updated_at,(SELECT body FROM support_ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message FROM support_tickets t ORDER BY FIELD(t.status,'open','in_progress','waiting_on_customer','resolved','closed'),t.updated_at DESC LIMIT 300`);
  return NextResponse.json({ tickets: rows });
}
export async function POST(req: NextRequest) {
  const guard = await requireAccess('support.use'); if (denied(guard)) return guard;
  const parsed = Create.safeParse(await req.json().catch(() => null)); if (!parsed.success) return NextResponse.json({ error: 'Subject and message are required.' }, { status: 400 });
  const db = getAppDb(); const [result] = await db.execute('INSERT INTO support_tickets (requester_user_id,subject,language,source_workspace_id) VALUES (?,?,?,?)', [guard.user.id, parsed.data.subject, parsed.data.language || null, parsed.data.workspaceId || null]);
  const id = (result as { insertId: number }).insertId; await db.execute('INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body,language) VALUES (?,?,?,?,?)', [id, guard.user.id, 'customer', parsed.data.body, parsed.data.language || null]); await audit(guard.user.id, 'support.ticket_created', String(id), { subject: parsed.data.subject }); return NextResponse.json({ id }, { status: 201 });
}
