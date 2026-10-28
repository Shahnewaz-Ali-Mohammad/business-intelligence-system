import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';
import { audit } from '@/lib/access/access-db';
import { ChatOpenAI } from '@langchain/openai';

const Create = z.object({ subject: z.string().trim().min(3).max(240), body: z.string().trim().min(1).max(20000), language: z.string().max(20).optional(), workspaceId: z.string().max(64).optional() });
async function answerFirst(id: number, subject: string, body: string, language?: string) {
  const [knowledge] = await getAppDb().execute('SELECT question,approved_answer FROM support_knowledge_entries ORDER BY created_at DESC LIMIT 20');
  const ai = new ChatOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-4o', temperature: 0.1, timeout: 30000, maxRetries: 0 });
  const result = await ai.invoke([{ role: 'system', content: `You are first-line ticketing support. Reply in the same language as the customer (${language || 'detect it'}). Use only the approved solutions below; if they do not answer, say you need to investigate and end with exactly [ESCALATE]. Be concise, human, and never invent database facts. Approved solutions: ${JSON.stringify(knowledge)}` }, { role: 'user', content: `Subject: ${subject}\nQuestion: ${body}` }]);
  const text = String(result.content).trim(); const escalate = text.includes('[ESCALATE]'); const clean = text.replace(/\s*\[ESCALATE\]\s*$/, '').trim();
  await getAppDb().execute('INSERT INTO support_ticket_messages (ticket_id,author_type,body,language) VALUES (?,?,?,?)', [id, 'ai', clean, language || null]);
  const [attemptRows] = await getAppDb().execute("SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id=? AND author_type='ai'", [id]);
  const attempts = Number((attemptRows as { n: number }[])[0]?.n || 0); const shouldEscalate = attempts >= 3;
  await getAppDb().execute('UPDATE support_tickets SET status=?, ai_summary=? WHERE id=?', [shouldEscalate ? 'open' : 'in_progress', `AI attempt ${attempts}${shouldEscalate ? '; escalated to human agent' : ''}`, id]);
  return { reply: clean, attempts, escalated: shouldEscalate };
}
export async function GET() {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard;
  const isAgent = guard.access.permissions.includes('support.use');
  const db = getAppDb();
  const [rows] = await db.execute(`SELECT t.id,t.subject,t.status,t.priority,t.requester_user_id,t.assigned_to,t.language,t.ai_summary,t.created_at,t.updated_at,(SELECT body FROM support_ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message FROM support_tickets t ${isAgent ? '' : 'WHERE t.requester_user_id=?'} ORDER BY FIELD(t.status,'open','in_progress','waiting_on_customer','resolved','closed'),t.updated_at DESC LIMIT 300`, isAgent ? [] : [guard.user.id]);
  return NextResponse.json({ tickets: rows });
}
export async function POST(req: NextRequest) {
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard;
  const parsed = Create.safeParse(await req.json().catch(() => null)); if (!parsed.success) return NextResponse.json({ error: 'Subject and message are required.' }, { status: 400 });
  const db = getAppDb(); const [result] = await db.execute('INSERT INTO support_tickets (requester_user_id,subject,language,source_workspace_id) VALUES (?,?,?,?)', [guard.user.id, parsed.data.subject, parsed.data.language || null, parsed.data.workspaceId || null]);
  const id = (result as { insertId: number }).insertId; await db.execute('INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body,language) VALUES (?,?,?,?,?)', [id, guard.user.id, 'customer', parsed.data.body, parsed.data.language || null]); let ai: { reply: string; attempts: number; escalated: boolean } | null = null; try { ai = await answerFirst(id, parsed.data.subject, parsed.data.body, parsed.data.language); } catch { await db.execute('UPDATE support_tickets SET status=?,ai_summary=? WHERE id=?', ['open', 'AI unavailable; escalated to human agent', id]); } await audit(guard.user.id, 'support.ticket_created', String(id), { subject: parsed.data.subject, ai: !!ai, escalated: !!ai?.escalated }); return NextResponse.json({ id, ai, escalated: !!ai?.escalated }, { status: 201 });
}
