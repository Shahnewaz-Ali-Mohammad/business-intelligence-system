import { getAppDb } from '@/lib/db/app-db';
import { addNotification } from './notifications.mjs';
import { presetRange } from './schedule-intent.mjs';

// Original chat (ISP warehouse) answers are re-run by asking the chat backend
// the same question again, so a scheduled run gives exactly what the chat
// would answer at that time.
const CHAT_API_INTERNAL_URL = process.env.CHAT_API_INTERNAL_URL ?? 'http://localhost:4100/api/chat';
export const ISP_WORKSPACE = 'isp-default';

export type IspQuestion = { question: string; days?: number | null; region?: string | null };
type ReportRow = { id: number; user_id: number; title: string; topic: string | null; chart_type: string | null; chart_spec: unknown; source_session_id: number | null; data: Record<string, unknown> };
type ChatResult = { title?: string; narrative?: string; topic?: string; chartType?: string; tablesUsed?: string[]; filters?: { days?: number; region?: string | null }; data?: Record<string, unknown> | null };

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** The question text for this run, with a rolling date range spelled out. */
export function questionForRun(saved: IspQuestion, dateRange: string | undefined, timezone: string, runAt: number) {
  const range = presetRange(dateRange, timezone, runAt);
  if (!range) return saved.question;
  const last = new Date(`${range.end}T00:00:00Z`); last.setUTCDate(last.getUTCDate() - 1);
  return `${saved.question} from ${range.start} to ${iso(last)}`;
}

async function askChatBackend(message: string, saved: IspQuestion) {
  const response = await fetch(CHAT_API_INTERNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: [], page_state: { page: 'chat', days: saved.days ?? 30, region: saved.region ?? null, kpis: [], chartSources: null, semanticQuery: null } }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new Error('The chat backend could not answer the scheduled question.');
  return (await response.json()) as ChatResult;
}

/** Posts the run to the original chat's "Scheduled reports" conversation. */
async function postToScheduledChat(userId: number, narrative: string, artifact: Record<string, unknown> | null, tablesUsed: string[] = []) {
  const db = getAppDb();
  const [rows] = await db.execute("SELECT id FROM chat_sessions WHERE user_id=? AND (warehouse_id IS NULL OR warehouse_id=?) AND title='Scheduled reports' ORDER BY id LIMIT 1", [userId, ISP_WORKSPACE]);
  let sessionId = (rows as { id: number }[])[0]?.id;
  if (!sessionId) {
    const [created] = await db.execute("INSERT INTO chat_sessions(user_id,title,warehouse_id) VALUES(?, 'Scheduled reports', ?)", [userId, ISP_WORKSPACE]);
    sessionId = (created as { insertId: number }).insertId;
  }
  await db.execute('INSERT INTO chat_messages(user_id,session_id,role,content,tables_used,report_data) VALUES(?,?,?,?,?,?)', [userId, sessionId, 'assistant', narrative, JSON.stringify(tablesUsed), artifact ? JSON.stringify(artifact) : null]);
  await db.execute('UPDATE chat_sessions SET updated_at=NOW() WHERE id=?', [sessionId]);
  return sessionId;
}

/** Re-runs one scheduled original-chat report; returns the new report id. */
export async function rerunIspReport(report: ReportRow, runAt: number, title: string, baseTitle: string) {
  const saved = report.data.ispQuestion as IspQuestion;
  const schedule = report.data.schedule as { timezone?: string; dateRange?: string } | undefined;
  const question = questionForRun(saved, schedule?.dateRange, schedule?.timezone || 'UTC', runAt);
  const range = presetRange(schedule?.dateRange, schedule?.timezone || 'UTC', runAt);
  // Fresh results only; the schedule itself stays on the original report.
  const meta = { scheduledFrom: report.id, generatedAt: runAt, ...(range ? { dateRange: range } : {}), ispQuestion: saved };
  const result = await askChatBackend(question, saved);
  const narrative = result.narrative || 'The scheduled question returned no answer.';
  const artifact = result.data
    ? { title, narrative, topic: result.topic ?? report.topic ?? 'dashboard', chartType: result.chartType ?? 'bar', data: result.data, days: result.filters?.days, region: result.filters?.region ?? null, tablesUsed: result.tablesUsed || [] }
    : null;
  const sessionId = await postToScheduledChat(report.user_id, narrative, artifact, result.tablesUsed);
  const [inserted] = await getAppDb().execute(
    'INSERT INTO generated_reports (user_id, title, narrative, topic, chart_type, data, chart_spec, source_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [report.user_id, title.slice(0, 255), narrative, result.topic ?? report.topic, report.chart_type, JSON.stringify({ ...(result.data || {}), ...meta }), report.chart_spec == null ? null : typeof report.chart_spec === 'string' ? report.chart_spec : JSON.stringify(report.chart_spec), sessionId],
  );
  const reportId = (inserted as { insertId: number }).insertId;
  await addNotification(report.user_id, { title: `Scheduled report ready: ${baseTitle}`, message: narrative.slice(0, 160), reportId, status: 'success' });
  return { reportId, status: 'completed' as const };
}
