import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppDb } from "@/lib/db/app-db";
import { requireAccess, denied } from "@/lib/access/guard";
import { audit } from "@/lib/access/access-db";
import {
  generateSupportAnswer,
  shouldEscalateRepeatedIssue,
  redactCustomerIdentifiers,
  redactSensitiveValues,
} from "@/lib/support/assistant";
const Update = z
  .object({
    status: z
      .enum([
        "open",
        "in_progress",
        "waiting_on_customer",
        "resolved",
        "closed",
      ])
      .optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    message: z.string().trim().min(1).max(20000).optional(),
    knowledge: z.boolean().optional(),
  })
  .strict();
const CustomerMessage = z
  .object({
    message: z.string().trim().min(1).max(20000),
    language: z.enum(["auto", "en", "bn"]).optional(),
  })
  .transform((value) => ({
    ...value,
    language:
      value.language === "auto" || !value.language
        ? /[ঀ-৿]/.test(value.message)
          ? "bn"
          : "en"
        : value.language,
  }));
async function aiReply(
  id: number,
  subject: string,
  message: string,
  language?: string,
) {
  const db = getAppDb();
  const { reply, escalationRequested, knowledgeUsed } =
    await generateSupportAnswer(subject, message, language);
  await db.execute(
    "INSERT INTO support_ticket_messages (ticket_id,author_type,body,language) VALUES (?,?,?,?)",
    [id, "ai", reply, language && language !== "auto" ? language : null],
  );
  const [a] = await db.execute(
    "SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id=? AND author_type='ai'",
    [id],
  );
  const attempts = Number((a as { n: number }[])[0]?.n || 0);
  const escalated = await shouldEscalateRepeatedIssue(id, message);
  await db.execute(
    "UPDATE support_tickets SET status=?,ai_summary=? WHERE id=?",
    [
      escalated ? "open" : "in_progress",
      `AI attempt ${attempts}; ${knowledgeUsed ? `used ${knowledgeUsed} approved solution(s)` : "no approved solution matched"}${escalated ? "; escalated to human agent" : ""}`,
      id,
    ],
  );
  return { reply, attempts, escalated, knowledgeUsed, escalationRequested };
}
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAccess("chat.use");
  if (denied(guard)) return guard;
  const id = Number((await params).id);
  if (!Number.isInteger(id))
    return NextResponse.json({ error: "Invalid ticket." }, { status: 400 });
  const isAgent = guard.access.permissions.includes("support.use");
  const [tickets] = await getAppDb().execute(
    `SELECT t.*,COALESCE(u.display_name,u.email,CONCAT('User #',t.requester_user_id)) AS customer_name,u.email AS customer_email,CASE WHEN LOWER(t.subject) REGEXP 'bill|payment|invoice' THEN 'Billing' WHEN LOWER(t.subject) REGEXP 'account|login|password' THEN 'Account' WHEN LOWER(t.subject) REGEXP 'ticket|status' THEN 'Ticket status' ELSE 'Connectivity' END AS ticket_type FROM support_tickets t LEFT JOIN users u ON u.id=t.requester_user_id WHERE t.id=? AND ${isAgent ? "1=1" : "t.requester_user_id=?"}`,
    isAgent ? [id] : [id, guard.user.id],
  );
  const [messages] = await getAppDb().execute(
    "SELECT * FROM support_ticket_messages WHERE ticket_id=? ORDER BY created_at,id",
    [id],
  );
  if (!(tickets as unknown[]).length)
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  return NextResponse.json({ ticket: (tickets as unknown[])[0], messages });
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAccess("chat.use");
  if (denied(guard)) return guard;
  const id = Number((await params).id);
  const parsed = CustomerMessage.safeParse(await req.json().catch(() => null));
  if (!Number.isInteger(id) || !parsed.success)
    return NextResponse.json(
      { error: "Message is required." },
      { status: 400 },
    );
  const [rows] = await getAppDb().execute(
    "SELECT subject,status,ai_summary,requester_user_id FROM support_tickets WHERE id=?",
    [id],
  );
  const ticket = (
    rows as {
      subject: string;
      status: string;
      ai_summary: string | null;
      requester_user_id: number;
    }[]
  )[0];
  if (
    !ticket ||
    (ticket.requester_user_id !== guard.user.id &&
      !guard.access.permissions.includes("support.use"))
  )
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  if (ticket.ai_summary?.includes("escalated to human agent")) {
    await getAppDb().execute(
      "INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body,language) VALUES (?,?,?,?,?)",
      [
        id,
        guard.user.id,
        "customer",
        parsed.data.message,
        parsed.data.language || null,
      ],
    );
    return NextResponse.json({
      handoff: true,
      message:
        "Your message was added to the human agent queue. AI is paused for this ticket.",
    });
  }
  await getAppDb().execute(
    "INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body,language) VALUES (?,?,?,?,?)",
    [
      id,
      guard.user.id,
      "customer",
      parsed.data.message,
      parsed.data.language || null,
    ],
  );
  try {
    const ai = await aiReply(
      id,
      ticket.subject,
      parsed.data.message,
      parsed.data.language,
    );
    return NextResponse.json({ ai, escalated: ai.escalated });
  } catch {
    const fallback =
      "Thanks for contacting support. I could not complete the automated lookup, so your request has been sent to a human support agent.";
    await getAppDb().execute(
      "INSERT INTO support_ticket_messages (ticket_id,author_type,body,language) VALUES (?,?,?,?)",
      [id, "ai", fallback, parsed.data.language || null],
    );
    await getAppDb().execute(
      "UPDATE support_tickets SET status=?,ai_summary=? WHERE id=?",
      ["open", "AI unavailable; escalated to human agent", id],
    );
    return NextResponse.json({
      ai: { reply: fallback, attempts: 0, escalated: true },
      escalated: true,
    });
  }
}
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAccess("support.manage");
  if (denied(guard)) return guard;
  const id = Number((await params).id);
  const parsed = Update.safeParse(await req.json().catch(() => null));
  if (!Number.isInteger(id) || !parsed.success)
    return NextResponse.json({ error: "Invalid update." }, { status: 400 });
  const db = getAppDb();
  const { status, priority, message, knowledge } = parsed.data;
  if (status || priority) {
    const fields = [
      status ? "status=?" : "",
      priority ? "priority=?" : "",
    ].filter(Boolean);
    const values: (string | number)[] = [];
    if (status) values.push(status);
    if (priority) values.push(priority);
    values.push(id);
    await db.execute(
      `UPDATE support_tickets SET ${fields.join(",")} WHERE id=?`,
      values,
    );
  }
  if (message)
    await db.execute(
      "INSERT INTO support_ticket_messages (ticket_id,author_user_id,author_type,body) VALUES (?,?,?,?)",
      [id, guard.user.id, "agent", message],
    );
  if (knowledge && message)
    await db.execute(
      "INSERT INTO support_knowledge_entries (ticket_id,question,approved_answer,approved_by) SELECT t.id,COALESCE((SELECT m.body FROM support_ticket_messages m WHERE m.ticket_id=t.id AND m.author_type='customer' ORDER BY m.id ASC LIMIT 1),t.subject),?,? FROM support_tickets t WHERE t.id=? AND NOT EXISTS (SELECT 1 FROM support_knowledge_entries k WHERE k.ticket_id=t.id)",
      [
        redactSensitiveValues(redactCustomerIdentifiers(message)),
        guard.user.id,
        id,
      ],
    );
  await audit(guard.user.id, "support.ticket_updated", String(id), {
    status,
    priority,
    knowledge: !!knowledge,
  });
  return NextResponse.json({ ok: true });
}
