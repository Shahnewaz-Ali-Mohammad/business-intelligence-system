import { ChatOpenAI } from "@langchain/openai";
import { getAppDb } from "@/lib/db/app-db";

type KnowledgeRow = { id: number; question: string; approved_answer: string };

const STOP_WORDS = new Set(
  "a an the and or for of to in on with from by as is are was were be been i me my we our you your it this that what how can could would should please help need want do does did there have has had about issue problem service".split(
    " ",
  ),
);
const TOPIC_ALIASES: Record<string, string> = {
  internet: "network",
  wifi: "network",
  wireless: "network",
  broadband: "network",
  network: "network",
  connection: "network",
  connected: "network",
  router: "equipment",
  modem: "equipment",
  onu: "equipment",
  equipment: "equipment",
  slow: "performance",
  slowly: "performance",
  speed: "performance",
  lag: "performance",
  buffering: "performance",
  dropping: "intermittent",
  disconnecting: "intermittent",
  disconnected: "intermittent",
  unstable: "intermittent",
  drops: "intermittent",
  los: "optical",
  pon: "optical",
  fiber: "optical",
  fibre: "optical",
  optical: "optical",
  red: "optical",
  outage: "service_down",
  offline: "service_down",
  down: "service_down",
  unavailable: "service_down",
};

function tokens(value: string) {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+|[\u0980-\u09ff]+/g) || [])
      .map((word) => word.replace(/s$/, ""))
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
      .map((word) => TOPIC_ALIASES[word] || word),
  );
}

function requestedReplyLanguage(language: string | undefined, message: string) {
  if (/^bn(?:g)?$/i.test(language || "") || /[\u0980-\u09ff]/.test(message))
    return "Bengali";
  if (/^en(?:g)?$/i.test(language || "")) return "English";
  // Customers often type Bangla using Latin letters (for example, “amar internet slow”).
  if (
    /\b(amar|apnar|kibhabe|ki korbo|ki kori|hocche|hoitese|dhire|cholche|choltese|nai|hobe|lagbe|korte hobe)\b/i.test(
      message,
    )
  )
    return "Bengali";
  return "English";
}

function retrieveRelevantKnowledge(query: string, rows: KnowledgeRow[]) {
  const queryTokens = tokens(query);
  if (!queryTokens.size) return [];
  const scored = rows.map((row) => {
    const noteTokens = tokens(`${row.question} ${row.approved_answer}`);
    const overlap = [...queryTokens].filter((word) =>
      noteTokens.has(word),
    ).length;
    const score = overlap / queryTokens.size;
    return { row, overlap, score };
  });
  return scored
    .filter(
      ({ overlap, score }) => overlap > 0 && (score >= 0.25 || overlap >= 2),
    )
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    .slice(0, 5)
    .map(({ row }) => ({
      question: row.question,
      approved_solution: row.approved_answer,
    }));
}

export function redactSensitiveValues(value: string) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]")
    .replace(
      /\b(?:customer|account|ticket|subscriber)\s*(?:id|number|no\.?|#)?\s*[:#-]?\s*\d{4,}\b/gi,
      "[identifier removed]",
    )
    .replace(
      /\b(?:password|passcode|one[- ]time code|verification code|OTP|access token)\s*(?:is|:|=)\s*[^\s,;]+/gi,
      "[credential removed]",
    )
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, "[phone removed]");
}

export function redactCustomerIdentifiers(text: string) {
  return text
    .replace(
      /\b(?:customer|account|ticket|subscriber)\s*(?:id|number|no\.?|#)?\s*[:#-]?\s*\d{4,}\b/gi,
      "your account",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "your email address",
    )
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, "your phone number");
}

/** Generate one brief customer-facing troubleshooting answer grounded in relevant approved ticket solutions. */
export async function generateSupportAnswer(
  subject: string,
  message: string,
  language?: string,
) {
  const [rows] = await getAppDb().execute(
    "SELECT id,question,approved_answer FROM support_knowledge_entries ORDER BY created_at DESC LIMIT 2000",
  );
  const knowledge = retrieveRelevantKnowledge(
    `${subject}\n${message}`,
    rows as KnowledgeRow[],
  ).map((entry) => ({
    question: redactSensitiveValues(entry.question),
    approved_solution: redactSensitiveValues(entry.approved_solution),
  }));
  const requestedLanguage = requestedReplyLanguage(language, message);
  const ai = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    temperature: 0,
    timeout: 30000,
    maxRetries: 0,
    maxTokens: 120,
  });
  const result = await ai.invoke([
    {
      role: "system",
      content: `You are an ISP internet-troubleshooting assistant. Reply only in ${requestedLanguage}. Give a direct, practical fix for the customer's current connectivity issue, using plain friendly language and at most 2 short steps (40 words maximum). Do not start with a greeting, say you are checking something, promise a later update, or claim you inspected a line, router, account, ticket, or database. Use only an approved solution below when it clearly matches; never combine unrelated solutions or invent ISP-specific policies. If none matches, give one safe basic check and say you cannot verify the line remotely. Never reveal or repeat personal data, account details, credentials, or customer-specific records. Do not claim a human has taken over unless the ticket is actually escalated. Approved solutions (use only when relevant): ${JSON.stringify(knowledge)}`,
    },
    {
      role: "user",
      content: `Issue: ${redactSensitiveValues(subject)}\nCustomer message: ${redactSensitiveValues(message)}`,
    },
  ]);
  const raw = String(result.content).trim();
  const escalationRequested = /\[ESCALATE\]/i.test(raw);
  const reply = redactCustomerIdentifiers(
    raw.replace(/\s*\[ESCALATE\]\s*/gi, "").trim(),
  );
  return { reply, escalationRequested, knowledgeUsed: knowledge.length };
}

/** Escalate on the third substantially repeated customer issue, not simply their third chat turn. */
export async function shouldEscalateRepeatedIssue(
  ticketId: number,
  currentMessage: string,
) {
  const current = tokens(currentMessage);
  if (!current.size) return false;
  const [rows] = await getAppDb().execute(
    "SELECT body FROM support_ticket_messages WHERE ticket_id=? AND author_type='customer' ORDER BY id ASC",
    [ticketId],
  );
  const prior = (rows as { body: string }[]).slice(0, -1);
  let similarPriorAsks = 0;
  for (const item of prior) {
    const previous = tokens(item.body);
    const overlap = [...current].filter((word) => previous.has(word)).length;
    const similarity =
      overlap / Math.max(1, Math.min(current.size, previous.size));
    if (similarity >= 0.7 || (current.size <= 2 && overlap === current.size))
      similarPriorAsks++;
  }
  return similarPriorAsks >= 2;
}
