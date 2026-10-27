import { getAppDb } from '@/lib/db/app-db';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getSource, getTool } from '@/lib/tool-setup/store';
import { discoverDatabase, executeTool, summarizeTool } from '@/lib/tool-setup/connectors.mjs';
import { recordNarrative } from '@/lib/tool-setup/record-presentation.mjs';
import { authorizeProcedureRun } from '@/lib/tool-setup/report-procedures.mjs';
import { procedureMetadata } from '@/lib/tool-setup/procedure-metadata';
import { createRun, readRun, writeRun } from '@/lib/tool-setup/procedure-run-store.mjs';
import { launchProcedureRun } from '@/lib/tool-setup/procedure-runs';
import { writeAnalyticalInsight } from '../../scripts/lib/analytical-insight.mjs';
import { nextRunAt } from './schedule-time.mjs';
import { addNotification } from './notifications.mjs';
import { rerunIspReport } from './run-isp-scheduled';
import { loadAccess, audit, disabledAtSql, canOpenWorkspace } from '@/lib/access/access-db';
import { runWithAccess } from '@/lib/access/data-scope.mjs';
import { presetRange, applyRangeToQuery, procedureRangeArguments } from './schedule-intent.mjs';

/**
 * Each workspace database has one "Scheduled reports" conversation; every
 * scheduled run posts its answer there, so results are in the chat too.
 */
async function postToScheduledChat(userId: number, workspaceId: string, sourceId: string, title: string, narrative: string, answer: Record<string, unknown>) {
  const db = await getAppDb().getConnection();
  try {
    await db.beginTransaction();
    const [sessions] = await db.execute(
      "SELECT s.id FROM chat_sessions s WHERE s.user_id=? AND s.warehouse_id=? AND s.title='Scheduled reports' AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id=s.id AND JSON_UNQUOTE(JSON_EXTRACT(m.report_data, '$.workspaceToolAnswer.sourceId'))<>?) ORDER BY s.id LIMIT 1",
      [userId, workspaceId, sourceId],
    );
    let sessionId = (sessions as { id: number }[])[0]?.id;
    if (!sessionId) {
      const [created] = await db.execute("INSERT INTO chat_sessions(user_id,title,warehouse_id) VALUES(?, 'Scheduled reports', ?)", [userId, workspaceId]);
      sessionId = (created as { insertId: number }).insertId;
    }
    await db.execute('INSERT INTO chat_messages(user_id,session_id,role,content,report_data) VALUES(?,?,?,?,?)', [userId, sessionId, 'user', `Scheduled run: ${title}`, null]);
    const [message] = await db.execute('INSERT INTO chat_messages(user_id,session_id,role,content,report_data) VALUES(?,?,?,?,?)', [userId, sessionId, 'assistant', narrative, JSON.stringify({ workspaceToolAnswer: { ...answer, sessionId } })]);
    await db.execute('UPDATE chat_sessions SET updated_at=NOW() WHERE id=?', [sessionId]);
    await db.commit();
    return { sessionId, messageId: (message as { insertId: number }).insertId };
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}

type Schedule = { enabled: boolean; frequency: string; time: string; timezone: string; dayOfWeek?: number; dayOfMonth?: number; nextRunAt?: number; lastRunAt?: number; lastStatus?: string; lastError?: string; lastReportId?: number };
type ReportRow = { id: number; user_id: number; title: string; topic: string | null; chart_type: string | null; chart_spec: unknown; source_session_id: number | null; data: string | Record<string, unknown> };
type ToolAnswer = Record<string, unknown> & { workspaceId?: string; sourceId?: string; toolId?: string; query?: string; title?: string; procedure?: { id: number; name: string; values: Record<string, unknown>; omitted?: string[] } };

const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;

/** Saves a new dated report (a copy of the scheduled one with fresh results). */
async function insertReport(source: ReportRow, data: Record<string, unknown>, narrative: string, title: string, sessionId: number | null = source.source_session_id) {
  const [result] = await getAppDb().execute(
    'INSERT INTO generated_reports (user_id, title, narrative, topic, chart_type, data, chart_spec, source_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [source.user_id, title.slice(0, 255), narrative, source.topic, source.chart_type, JSON.stringify(data), source.chart_spec == null ? null : typeof source.chart_spec === 'string' ? source.chart_spec : JSON.stringify(source.chart_spec), sessionId],
  );
  return (result as { insertId: number }).insertId;
}

/** Re-runs one saved report exactly like running it by hand; returns the new report id. */
export async function rerunReport(report: ReportRow, runAt = Date.now()) {
  const data = parse(report.data);
  const answer = data.workspaceToolAnswer as ToolAnswer | undefined;
  if (!answer && data.ispQuestion) {
    // Original chat: ask the same question again.
    const timezone = (data.schedule as { timezone?: string } | undefined)?.timezone || 'UTC';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(runAt)).map((p) => [p.type, p.value]));
    const baseTitle = report.title.replace(/ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '');
    return rerunIspReport({ ...report, data }, runAt, `${baseTitle} · ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, baseTitle);
  }
  if (!answer?.workspaceId || !answer.sourceId) throw new Error('This report has no saved question or query to run again.');
  const workspace = await getWorkspace(answer.workspaceId);
  if (!workspace) throw new Error('The report’s workspace is no longer available.');
  // Dated in the schedule's own timezone, e.g. "2026-10-18 13:30".
  const timezone = (data.schedule as { timezone?: string } | undefined)?.timezone || 'UTC';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(runAt)).map((p) => [p.type, p.value]));
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  const baseTitle = report.title.replace(/ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '');
  const title = `${baseTitle} · ${stamp}`;
  // Rolling dates ("last month", "yesterday"...) are worked out for this run.
  const range = presetRange((data.schedule as { dateRange?: string } | undefined)?.dateRange, timezone, runAt);
  const copy: Record<string, unknown> = { ...data, scheduledFrom: report.id, generatedAt: runAt, ...(range ? { dateRange: range } : {}) };
  delete copy.schedule;
  const source = await getSource(answer.workspaceId, answer.sourceId);

  if (answer.procedure) {
    // Same checks as a manual run: still available, unchanged, and read-only
    // (procedures that need write permission are never run unattended).
    const [procedure] = await procedureMetadata(source.config, answer.procedure.id);
    if (!procedure) throw new Error('The stored procedure no longer exists.');
    authorizeProcedureRun(procedure, null, { hash: procedure.hash, allowBusinessWrites: false });
    const ranged = procedureRangeArguments(answer.procedure.values, procedure.parameters, answer.procedure.omitted || [], range);
    const values = ranged.values;
    const omitted = ranged.omitted;
    const run = await createRun(answer.workspaceId, { sourceId: answer.sourceId, userId: report.user_id, procedure: { id: procedure.id, schema: procedure.schema, name: procedure.name, parameters: procedure.parameters, hash: procedure.hash }, values, omitted, allowBusinessWrites: false, reportTitle: baseTitle, scheduledFrom: report.id });
    const narrative = `Running ${procedure.schema}.${procedure.name}…`;
    const runAnswer = { ...answer, title, narrative, rows: [], procedure: { ...answer.procedure, values, omitted, runId: run.id } };
    const chat = await postToScheduledChat(report.user_id, answer.workspaceId, answer.sourceId, title, narrative, runAnswer);
    const reportId = await insertReport(report, { ...copy, semanticQueryTable: { headers: [], rows: [] }, workspaceToolAnswer: { ...runAnswer, sessionId: chat.sessionId } }, narrative, title, chat.sessionId);
    await writeRun(answer.workspaceId, { ...(await readRun(answer.workspaceId, run.id)), reportId, messageId: chat.messageId });
    // Recorded before the worker starts, so a fast procedure's "completed" is never overwritten.
    await getAppDb().execute("UPDATE generated_reports SET data = JSON_SET(data, '$.schedule.lastStatus', 'running', '$.schedule.lastReportId', ?, '$.schedule.lastError', NULL) WHERE id = ?", [reportId, report.id]);
    launchProcedureRun(answer.workspaceId, run.id);
    return { reportId, status: 'running' as const };
  }

  if (!answer.toolId || typeof answer.query !== 'string') throw new Error('This report has no saved query.');
  const tool = await getTool(answer.workspaceId, answer.toolId);
  if (tool.status !== 'approved') throw new Error('The report’s tool is no longer approved.');
  const catalog = await discoverDatabase(source.config);
  if (catalog.fingerprint !== tool.catalog_fingerprint) throw new Error('The database structure changed. Review the tool, then re-approve it.');
  const dateFields = new Set(catalog.objects.flatMap((o: { id: string; columns: { name: string; dataType: string }[] }) => o.columns.filter((c) => /date|time/i.test(c.dataType)).map((c) => `${o.id}:${c.name}`)));
  const query = applyRangeToQuery(answer.query, range, (field: string) => dateFields.has(field));
  const result = await executeTool(source.config, tool.definition, catalog, { query }, 200, 0, { maxLimit: 200 });
  let summary;
  try { summary = await summarizeTool(source.config, tool.definition, catalog, { query }); } catch { summary = undefined; }
  const countLine = tool.definition.mode === 'rows' ? recordNarrative(result, summary, query) : '';
  let insight = '';
  try { if (summary) insight = await (writeAnalyticalInsight as unknown as (input: Record<string, unknown>) => Promise<string>)({ question: baseTitle, summary, records: result.rows.length <= 5 && !result.hasMore ? result.rows : undefined, currency: undefined, signal: AbortSignal.timeout(30000) }); } catch { insight = ''; }
  const narrative = [countLine, insight].filter(Boolean).join(' ') || 'The verified database results are shown in the table below.';
  const headers = Object.keys(result.rows[0] || {});
  const runAnswer = { ...answer, title, narrative, ...result, query, summary, page: 1, totalCount: summary ? Number(summary.population) || result.rows.length : undefined };
  const chat = await postToScheduledChat(report.user_id, answer.workspaceId, answer.sourceId, title, narrative, runAnswer);
  const reportId = await insertReport(report, {
    ...copy,
    semanticQueryTable: { headers, rows: result.rows.map((row: Record<string, unknown>) => headers.map((k) => (row[k] == null ? '' : String(row[k])))) },
    workspaceToolAnswer: { ...runAnswer, sessionId: chat.sessionId },
  }, narrative, title, chat.sessionId);
  await addNotification(report.user_id, { title: `Scheduled report ready: ${baseTitle}`, message: countLine || narrative.slice(0, 160), reportId, status: 'success' });
  return { reportId, status: 'completed' as const };
}

/**
 * Runs every scheduled report that is due. Each report is claimed first by
 * moving its next run time forward, so overlapping calls never run it twice.
 */
export async function runDueReports(now = Date.now()) {
  const db = getAppDb();
  const [rows] = await db.execute(
    "SELECT id, user_id, title, topic, chart_type, chart_spec, source_session_id, data FROM generated_reports WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.schedule.enabled')) = 'true' AND CAST(JSON_EXTRACT(data, '$.schedule.nextRunAt') AS UNSIGNED) <= ? ORDER BY id LIMIT 25",
    [now],
  );
  const outcomes: { reportId: number; status: string; newReportId?: number; error?: string }[] = [];
  for (const report of rows as ReportRow[]) {
    const schedule = parse(report.data).schedule as Schedule;
    const next = nextRunAt(schedule as Parameters<typeof nextRunAt>[0], now);
    const [claimed] = await db.execute(
      "UPDATE generated_reports SET data = JSON_SET(data, '$.schedule.nextRunAt', ?, '$.schedule.lastRunAt', ?) WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.schedule.enabled')) = 'true' AND JSON_EXTRACT(data, '$.schedule') = JSON_EXTRACT(?, '$')",
      [next, now, report.id, JSON.stringify(schedule)],
    );
    if (!(claimed as { affectedRows: number }).affectedRows) continue;
    try {
      // Runs with the owner's CURRENT role and departments, never the ones
      // they had when the schedule was created.
      const [owners] = await db.execute(`SELECT ${await disabledAtSql()} AS disabled_at FROM users u WHERE u.id=?`, [report.user_id]);
      const owner = (owners as { disabled_at: unknown }[])[0];
      if (!owner || owner.disabled_at) throw new Error('The owner of this schedule no longer has an active account.');
      const access = await loadAccess(report.user_id);
      if (!access.permissions.includes('reports.schedule')) throw new Error('The owner of this schedule is no longer allowed to schedule reports.');
      // The owner must still be allowed into the report's workspace.
      const data = typeof report.data === 'string' ? JSON.parse(report.data) : report.data;
      const workspaceId = (data?.workspaceToolAnswer?.workspaceId as string | undefined) || (data?.ispQuestion ? 'isp-default' : undefined);
      if (!workspaceId || !(await canOpenWorkspace(access, workspaceId))) throw new Error('The owner of this schedule no longer has access to its workspace.');
      const outcome = await runWithAccess(access, () => rerunReport(report, now));
      void audit(report.user_id, 'schedule.run', String(report.id), { status: outcome.status, reportId: outcome.reportId });
      if (outcome.status === 'completed') await db.execute("UPDATE generated_reports SET data = JSON_SET(data, '$.schedule.lastStatus', ?, '$.schedule.lastReportId', ?, '$.schedule.lastError', NULL) WHERE id = ?", [outcome.status, outcome.reportId, report.id]);
      outcomes.push({ reportId: report.id, status: outcome.status, newReportId: outcome.reportId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scheduled report failed.';
      await db.execute("UPDATE generated_reports SET data = JSON_SET(data, '$.schedule.lastStatus', 'failed', '$.schedule.lastError', ?) WHERE id = ?", [message.slice(0, 500), report.id]);
      await addNotification(report.user_id, { title: `Scheduled report failed: ${report.title}`, message, reportId: report.id, status: 'error' }).catch(() => {});
      outcomes.push({ reportId: report.id, status: 'failed', error: message });
    }
  }
  return { checkedAt: now, due: (rows as unknown[]).length, outcomes };
}
