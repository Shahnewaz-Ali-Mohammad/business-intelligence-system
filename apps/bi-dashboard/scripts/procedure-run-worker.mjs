// Runs one approved stored-procedure report in the background. Rows are
// streamed to disk as they arrive (no row, size, table or time limit), the
// run status is updated while it works, and the chat answer is completed
// when it finishes.
import mysql from 'mysql2/promise';
import { decryptConnectionString } from '../lib/workspaces/secrets.ts';
import { streamReportProcedure } from '../lib/tool-setup/sqlserver-procedure-runner.mjs';
import { readRun, writeRun, openResultWriter, cancelRequested } from '../lib/tool-setup/procedure-run-store.mjs';
import { writeAnalyticalInsight } from './lib/analytical-insight.mjs';
import { addNotification } from '../lib/schedules/notifications.mjs';
import { loadProcedureMetadata } from '../lib/tool-setup/procedure-catalog.mjs';
import { authorizeProcedureRun } from '../lib/tool-setup/report-procedures.mjs';

const [workspaceId, runId] = process.argv.slice(2);
const db = mysql.createPool({ host: process.env.DB_APP_HOST || 'localhost', port: Number(process.env.DB_APP_PORT || 3306), database: process.env.DB_APP_NAME || 'bi_app', user: process.env.DB_APP_USER || 'bi_app_user', password: process.env.DB_APP_PASSWORD || '', connectionLimit: 2 });
const controller = new AbortController();
const SAMPLE = 200000; // values kept per column for the median (exact up to this many values)

/** Running statistics for one column: count, min, max, total and a median sample. */
function columnStats() {
  return { present: 0, missing: 0, numeric: 0, minimum: null, maximum: null, total: 0, sample: [], seen: 0 };
}
function track(stats, value) {
  if (value == null || value === '') { stats.missing++; return; }
  stats.present++;
  const number = typeof value === 'number' ? value : (typeof value === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN);
  if (!Number.isFinite(number)) return;
  stats.numeric++; stats.total += number;
  if (stats.minimum === null || number < stats.minimum) stats.minimum = number;
  if (stats.maximum === null || number > stats.maximum) stats.maximum = number;
  stats.seen++;
  if (stats.sample.length < SAMPLE) stats.sample.push(number);
  else { const slot = Math.floor(Math.random() * stats.seen); if (slot < SAMPLE) stats.sample[slot] = number; }
}
function finishStats(stats) {
  const sorted = stats.sample.sort((a, b) => a - b); const n = sorted.length;
  return { present: stats.numeric, missing: stats.missing + (stats.present - stats.numeric), minimum: stats.minimum, maximum: stats.maximum, total: stats.total, average: stats.numeric ? stats.total / stats.numeric : null, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null, medianEstimated: stats.seen > SAMPLE };
}
const isMeasure = name => !/(?:^id$|id$|_sk$|code$|no$|number$|phone|mobile|year$|month$)/i.test(name);

let run;
let heartbeat;
let finished = false;
let beat = Promise.resolve();
try {
  run = await readRun(workspaceId, runId);
  if (!run || run.status !== 'queued') process.exit(0);
  run = await writeRun(workspaceId, { ...run, status: 'running', workerPid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), progress: 'Running the procedure' });
  const [sources] = await db.execute("SELECT s.database_name,v.encrypted_config,JSON_EXTRACT(s.catalog_json, '$.reportProcedureApprovals') AS approvals FROM bi_tool_sources s JOIN bi_tool_servers v ON v.id=s.server_id JOIN workspaces w ON w.id=v.workspace_id WHERE s.id=? AND v.workspace_id=? AND w.owner_user_id=?", [run.sourceId, workspaceId, run.userId]);
  if (!sources[0]) throw new Error('Database source unavailable.');
  const config = { ...JSON.parse(decryptConnectionString(sources[0].encrypted_config)), database: sources[0].database_name };

  const sets = []; const writers = []; const stats = [];
  const status = () => ({ resultSets: sets.map((set, i) => ({ columns: set.columns, rowCount: writers[i]?.rows ?? 0 })) });
  heartbeat = setInterval(() => { beat = beat.then(async () => {
    if (finished) return;
    try {
      if (await cancelRequested(workspaceId, runId)) controller.abort(new Error('Report cancelled.'));
      const total = writers.reduce((sum, w) => sum + w.rows, 0);
      await Promise.all(writers.map(w => w.flush()));
      if (!finished) run = await writeRun(workspaceId, { ...run, ...status(), heartbeatAt: Date.now(), progress: `Running · ${total.toLocaleString('en-US')} rows received` });
    } catch {}
  }); }, 2000);

  const [current] = await loadProcedureMetadata(config, run.procedure.id);
  if (!current) throw new Error('Procedure is no longer available.');
  const [approvalRows] = await db.execute("SELECT JSON_EXTRACT(catalog_json, '$.reportProcedureApprovals') AS approvals FROM bi_tool_sources WHERE id=?", [run.sourceId]);
  const rawApprovals = approvalRows[0]?.approvals;
  const approvals = typeof rawApprovals === 'string' ? JSON.parse(rawApprovals) : rawApprovals || {};
  authorizeProcedureRun(current, approvals[String(current.id)], { hash: run.procedure.hash, allowBusinessWrites: run.allowBusinessWrites });
  if (await cancelRequested(workspaceId, runId)) { controller.abort(); throw new Error('Report cancelled before execution.'); }
  const result = await streamReportProcedure(config, current, run.values, run.omitted || [], {
    signal: controller.signal,
    onResultSet: async (index, columns) => {
      sets[index] = { columns }; stats[index] = Object.fromEntries(columns.map(c => [c, columnStats()]));
      writers[index] = await openResultWriter(workspaceId, runId, index);
    },
    onRow: async (index, row) => {
      await writers[index].add(row);
      const columnStatsForSet = stats[index];
      for (const key in row) if (columnStatsForSet[key]) track(columnStatsForSet[key], row[key]);
    },
    onMessage: message => { run.messages = [...(run.messages || []), message].slice(-50); },
  });
  finished = true; clearInterval(heartbeat); await beat;
  for (const writer of writers) await writer.close();

  const totals = status();
  const rowCount = totals.resultSets.reduce((sum, set) => sum + set.rowCount, 0);
  const summaries = totals.resultSets.map((set, i) => ({
    population: set.rowCount,
    scope: 'Full procedure result',
    numeric: set.columns.filter(c => isMeasure(c) && stats[i][c].numeric > 0 && stats[i][c].numeric >= stats[i][c].present * 0.9).slice(0, 12).map(c => ({ title: c, statistics: finishStats(stats[i][c]) })),
  }));
  const title = `${run.procedure.schema}.${run.procedure.name}`;
  const countLine = `${title} returned ${totals.resultSets.length.toLocaleString('en-US')} result table${totals.resultSets.length === 1 ? '' : 's'} with ${rowCount.toLocaleString('en-US')} rows.`;
  let insight = '';
  const main = summaries.findIndex(s => s.population > 0);
  if (main >= 0) {
    try { insight = await writeAnalyticalInsight({ question: `Summarize the results of the ${title} report.`, summary: summaries[main], currency: undefined, signal: AbortSignal.timeout(30000) }); }
    catch { insight = ''; }
  }
  const narrative = [countLine, insight].filter(Boolean).join(' ');
  run = await writeRun(workspaceId, { ...run, ...totals, status: 'completed', finishedAt: Date.now(), heartbeatAt: Date.now(), progress: 'Completed', output: result.output, returnValue: result.returnValue, rowsAffected: result.rowsAffected, summaries, narrative });
  if (run.messageId) {
    await db.execute("UPDATE chat_messages SET content=?, report_data=JSON_SET(report_data, '$.workspaceToolAnswer.narrative', ?, '$.workspaceToolAnswer.totalCount', ?) WHERE id=? AND user_id=?", [narrative, narrative, rowCount, run.messageId, run.userId]);
  }
  // A scheduled run completes its saved report and notifies its owner.
  if (run.reportId) {
    await db.execute("UPDATE generated_reports SET narrative=?, data=JSON_SET(data, '$.workspaceToolAnswer.narrative', ?, '$.workspaceToolAnswer.totalCount', ?) WHERE id=? AND user_id=?", [narrative, narrative, rowCount, run.reportId, run.userId]);
    await addNotification(run.userId, { title: `Scheduled report ready: ${run.reportTitle || title}`, message: countLine, reportId: run.reportId, status: 'success' });
    if (run.scheduledFrom) await db.execute("UPDATE generated_reports SET data=JSON_SET(data, '$.schedule.lastStatus', 'completed') WHERE id=? AND user_id=? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.schedule.lastReportId'))=?", [run.scheduledFrom, run.userId, String(run.reportId)]);
  }
} catch (error) {
  finished = true; clearInterval(heartbeat); await beat;
  const cancelled = controller.signal.aborted;
  const message = cancelled ? 'Report cancelled. A procedure that had already changed data is not undone.' : error instanceof Error ? error.message : 'Report failed.';
  if (run) {
    await writeRun(workspaceId, { ...run, status: cancelled ? 'cancelled' : 'failed', finishedAt: Date.now(), error: message, progress: cancelled ? 'Cancelled' : 'Failed' }).catch(() => {});
    if (run.messageId) await db.execute("UPDATE chat_messages SET content=?, report_data=JSON_SET(report_data, '$.workspaceToolAnswer.narrative', ?) WHERE id=? AND user_id=?", [message, message, run.messageId, run.userId]).catch(() => {});
    if (run.reportId) {
      await db.execute("UPDATE generated_reports SET narrative=?, data=JSON_SET(data, '$.workspaceToolAnswer.narrative', ?) WHERE id=? AND user_id=?", [message, message, run.reportId, run.userId]).catch(() => {});
      await addNotification(run.userId, { title: `Scheduled report failed: ${run.reportTitle || run.procedure?.name || 'report'}`, message, reportId: run.reportId, status: 'error' }).catch(() => {});
      if (run.scheduledFrom) await db.execute("UPDATE generated_reports SET data=JSON_SET(data, '$.schedule.lastStatus', 'failed', '$.schedule.lastError', ?) WHERE id=? AND user_id=?", [message.slice(0, 500), run.scheduledFrom, run.userId]).catch(() => {});
    }
  }
} finally {
  await db.end();
  process.exit(0);
}
