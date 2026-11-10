import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppDb } from "@/lib/db/app-db";
import { requireAccess, denied } from "@/lib/access/guard";
import { audit } from "@/lib/access/access-db";
import {
  generateSupportAnswer,
  shouldEscalateRepeatedIssue,
} from "@/lib/support/assistant";

const Create = z.object({
  subject: z.string().trim().min(1).max(240).optional(),
  body: z.string().trim().min(1).max(20000),
  language: z.enum(["auto", "en", "bn"]).optional(),
  workspaceId: z.string().max(64).optional(),
});
async function answerFirst(
  id: number,
  subject: string,
  body: string,
  language?: string,
) {
  const { reply, escalationRequested, knowledgeUsed } =
    await generateSupportAnswer(subject, body, language);
  await getAppDb().execute(
    "INSERT INTO support_ticket_messages (ticket_id,author_type,body,language) VALUES (?,?,?,?)",
    [id, "ai", reply, language && language !== "auto" ? language : null],
  );
  const [attemptRows] = await getAppDb().execute(
    "SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id=? AND author_type='ai'",
    [id],
  );
  const attempts = Number((attemptRows as { n: number }[])[0]?.n || 0);
  const shouldEscalate = await shouldEscalateRepeatedIssue(id, body);
  await getAppDb().execute(
    "UPDATE support_tickets SET status=?, ai_summary=? WHERE id=?",
    [
      shouldEscalate ? "open" : "in_progress",
      `AI attempt ${attempts}; ${knowledgeUsed ? `used ${knowledgeUsed} approved solution(s)` : "no approved solution matched"}${shouldEscalate ? "; escalated to human agent" : ""}`,
      id,
    ],
  );
  return {
    reply,
    attempts,
    escalated: shouldEscalate,
    knowledgeUsed,
    escalationRequested,
  };
}
export async function GET() {
  const guard = await requireAccess("chat.use");
  if (denied(guard)) return guard;
  const isAgent = guard.access.permissions.includes("support.use");
  const db = getAppDb();
  const [rows] = await db.execute(
    `SELECT t.id,t.subject,t.status,t.priority,t.requester_user_id,t.assigned_to,t.language,t.ai_summary,t.created_at,t.updated_at,
    COALESCE(u.display_name,u.email,CONCAT('User #',t.requester_user_id)) AS customer_name,u.email AS customer_email,
    CASE WHEN LOWER(t.subject) REGEXP 'bill|payment|invoice' THEN 'Billing' WHEN LOWER(t.subject) REGEXP 'account|login|password' THEN 'Account' WHEN LOWER(t.subject) REGEXP 'ticket|status' THEN 'Ticket status' ELSE 'Connectivity' END AS ticket_type,
    (SELECT body FROM support_ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,
    (SELECT body FROM support_ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='customer' ORDER BY m.id ASC LIMIT 1) AS issue_summary
    FROM support_tickets t LEFT JOIN users u ON u.id=t.requester_user_id ${isAgent ? "" : "WHERE t.requester_user_id=?"} ORDER BY FIELD(t.status,'open','in_progress','waiting_on_customer','resolved','closed'),t.updated_at DESC LIMIT 300`,
    isAgent ? [] : [guard.user.id],
  );
  return NextResponse.json({ tickets: rows });
}
export async function POST(req: NextRequest) {
  const guard = await requireAccess("chat.use");
  if (denied(guard)) return guard;
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Subject and message are required." },
      { status: 400 },
    );
  const subject = parsed.data.subject || parsed.data.body.slice(0, 80);
  const db = getAppDb();
  const [result] = await db.execute(
    "INSERT INTO support_tickets (requester_user_id,subject,language,source_workspace_id) VALUES (?,?,?,?)",
    [
      guard.user.id,
      subject,
      parsed.data.language || null,
      parsed.data.workspaceId || null,
    ],
  );
  const id = (result as { insertId: number }).insertId;
  await db.execute(
    "INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body,language) VALUES (?,?,?,?,?)",
    [
      id,
      guard.user.id,
      "customer",
      parsed.data.body,
      parsed.data.language || null,
    ],
  );
  let ai: { reply: string; attempts: number; escalated: boolean } | null = null;
  try {
    ai = await answerFirst(id, subject, parsed.data.body, parsed.data.language);
  } catch {
    const fallback =
      "I couldn’t verify a fix automatically. A support agent will take a look and reply here.";
    await db.execute(
      "INSERT INTO support_ticket_messages (ticket_id,author_type,body,language) VALUES (?,?,?,?)",
      [
        id,
        "ai",
        fallback,
        parsed.data.language && parsed.data.language !== "auto"
          ? parsed.data.language
          : null,
      ],
    );
    await db.execute(
      "UPDATE support_tickets SET status=?,ai_summary=? WHERE id=?",
      ["open", "AI unavailable; escalated to human agent", id],
    );
    ai = { reply: fallback, attempts: 0, escalated: true };
  }
  await audit(guard.user.id, "support.ticket_created", String(id), {
    subject,
    ai: !!ai,
    escalated: !!ai?.escalated,
  });
  return NextResponse.json(
    { id, ai, escalated: !!ai?.escalated },
    { status: 201 },
  );
}
