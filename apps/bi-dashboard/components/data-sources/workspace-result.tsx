"use client";
import { useEffect, useRef, useState } from "react";
import { ColumnMenu } from '@/components/dashboard/tables/column-menu';
import { ProcedureGraph, type ProcedureGraphSettings } from './procedure-graph';
import {
  ChevronLeft,
  ChevronRight,
  Save,
  ChartColumn,
  Download,
  FileText,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ReportCard } from '@/components/chat/report-card';
import { Button } from '@/components/ui/button';
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, buildWorkbookBase64, triggerDownload } from '@/lib/download';
export type WorkspaceAnswer = {
  procedure?: { id: number; name: string; runId?: string; values: Record<string, unknown>; omitted?: string[]; resultSets?: { columns: string[]; rows: Record<string, unknown>[] }[]; output?: Record<string, unknown>; returnValue?: number | null; rowsAffected?: number[]; messages?: string[] };
  columns?: string[];
  hiddenResultColumns?: Record<string, string[]>;
  procedureActiveResult?: number;
  procedureGraphs?: Record<string, ProcedureGraphSettings>;
  hiddenColumns?: string[];
  missingScenario?: {question:string;gap:string;jobId?:string};
  title?: string;
  narrative: string;
  rows: Record<string, unknown>[];
  hasMore: boolean;
  scope?: string;
  toolId?: string;
  query?: string;
  page?: number;
  mode?: string;
  sessionId?: number;
  graphVisible?: boolean;
  graphMetric?: string;
  graphCategory?: string;
  sourceId?: string;
  graphResult?: { rows: Record<string, unknown>[]; category: string; metric: string; hasMore: boolean; scope: string };
  totalCount?: number;
};

type ProcedureRun = { status: string; progress?: string; error?: string; narrative?: string; resultSets: { columns: string[]; rowCount: number }[]; output?: Record<string, unknown>; returnValue?: number | null };

// Chat shows at most this many rows; the saved report pages through all.
const CHAT_ROW_CAP = 200;
const REPORT_PAGE_SIZE = 100;
const axisLabel = (value: unknown) => {
  const label = String(value ?? 'Missing');
  return label.length > 12 ? `${label.slice(0, 9)}...` : label;
};
export function WorkspaceResult({
  id,
  initial,
  variant = "chat",
  reportId,
  onNarrative,
}: {
  id: string;
  initial: WorkspaceAnswer;
  variant?: "chat" | "report";
  reportId?: number;
  /** Called with the finished answer text of a background report. */
  onNarrative?: (text: string) => void;
}) {
  const isReport = variant === "report";
  const [answer, setAnswer] = useState<WorkspaceAnswer>(() => {
    if (initial.procedure) return initial;
    if (isReport) {
      // The report pages 100 rows at a time from the database.
      const page = initial.page || 1;
      if (page === 1 && initial.rows.length > REPORT_PAGE_SIZE)
        return { ...initial, rows: initial.rows.slice(0, REPORT_PAGE_SIZE), hasMore: true };
      return initial;
    }
    return { ...initial, rows: initial.rows.slice(0, CHAT_ROW_CAP) };
  });
  const [activeResult, setActiveResult] = useState(initial.procedureActiveResult || 0);
  const [procedurePage, setProcedurePage] = useState(1);
  // Stored-procedure runs execute in the background and keep every row on
  // the server; this view polls the run and loads one page at a time.
  const runId = answer.procedure?.runId;
  // Kept in a ref so a new callback from the parent does not refetch the run.
  const narrativeRef = useRef(onNarrative);
  useEffect(() => { narrativeRef.current = onNarrative; });
  const [run, setRun] = useState<ProcedureRun | null>(null);
  const [runRows, setRunRows] = useState<Record<string, unknown>[]>([]);
  const running = !!runId && (!run || run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!runId) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        // Like every chat answer, chat shows the first 200 rows; the saved
        // report pages through all of them.
        const pages = isReport ? [procedurePage] : [1, 2];
        const responses = await Promise.all(pages.map((p) => fetch(`/api/workspaces/${id}/procedures/runs/${runId}?set=${activeResult}&page=${p}`).then(async (r) => ({ ok: r.ok, data: await r.json() }))));
        if (stopped) return;
        const data = responses[0].data;
        if (!responses[0].ok) { setRun({ status: 'failed', error: data.error || 'Report run unavailable.', resultSets: [] }); return; }
        setRun(data); setRunRows(responses.flatMap((r) => r.data.rows || []));
        if (data.status === 'completed' && data.narrative) {
          setAnswer(previous => previous.narrative === data.narrative ? previous : { ...previous, narrative: data.narrative });
          narrativeRef.current?.(data.narrative);
        }
        if (data.status === 'queued' || data.status === 'running') timer = setTimeout(load, 2000);
      } catch { if (!stopped) timer = setTimeout(load, 4000); }
    };
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [id, runId, activeResult, procedurePage, isReport]);
  const procedureSets = runId ? run?.resultSets?.map((set) => ({ columns: set.columns, rows: [] as Record<string, unknown>[], rowCount: set.rowCount })) : answer.procedure?.resultSets?.map((set) => ({ ...set, rowCount: set.rows.length }));
  const activeSet = procedureSets?.[activeResult];
  const sourceRows = runId ? runRows : activeSet?.rows || answer.rows;
  const totalCount = answer.procedure ? activeSet?.rowCount ?? sourceRows.length : typeof answer.totalCount === "number" ? answer.totalCount : undefined;
  const displayRows = runId ? runRows : answer.procedure ? sourceRows.slice(isReport ? (procedurePage - 1) * REPORT_PAGE_SIZE : 0, isReport ? procedurePage * REPORT_PAGE_SIZE : CHAT_ROW_CAP) : answer.rows;
  const procedureOutput = runId ? run?.output : answer.procedure?.output;
  const procedureReturn = runId ? run?.returnValue : answer.procedure?.returnValue;
  async function cancelRun() {
    if (!runId) return;
    await fetch(`/api/workspaces/${id}/procedures/runs/${runId}`, { method: 'POST' }).catch(() => {});
  }
  const pageCount = totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / REPORT_PAGE_SIZE)) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<number>();
  const [graph, setGraph] = useState(initial.graphVisible || false);
  const [metricChoice, setMetricChoice] = useState(initial.graphMetric || "");
  const [categoryChoice, setCategoryChoice] = useState(initial.graphCategory || "");
  const [graphResult, setGraphResult] = useState(initial.graphResult);
  const keys = activeSet?.columns || answer.columns || Object.keys(answer.rows[0] || {});
  const [legacyHiddenColumns, setHiddenColumns] = useState(initial.hiddenColumns || []);
  const [hiddenResultColumns, setHiddenResultColumns] = useState(initial.hiddenResultColumns || {});
  const [procedureGraphs, setProcedureGraphs] = useState(initial.procedureGraphs || {});
  const hiddenColumns = answer.procedure ? hiddenResultColumns[String(activeResult)] || (activeResult === 0 ? initial.hiddenColumns || [] : []) : legacyHiddenColumns;
  const visibleKeys = keys.filter(key => !hiddenColumns.includes(key));
  const numericKeys = answer.procedure ? [] : keys.filter(
    (k) =>
      answer.rows.some((r) => r[k] != null && r[k] !== "") &&
      answer.rows.every(
        (r) => r[k] == null || r[k] === "" || Number.isFinite(Number(r[k])),
      ),
  );
  let metricAliases: string[] = [];
  try {
    metricAliases =
      JSON.parse(answer.query || "{}").metrics?.map(
        (m: { alias: string }) => m.alias,
      ) || [];
  } catch {
    /* Older snapshots may not contain a query. */
  }
  const metricKeys = numericKeys.filter((k) => metricAliases.includes(k));
  const metric = metricKeys.includes(metricChoice)
    ? metricChoice
    : metricKeys[0];
  const categoryKeys = keys.filter((k) => !metricAliases.includes(k));
  const category = categoryKeys.includes(categoryChoice)
    ? categoryChoice
    : categoryKeys[0];
  async function generateGraph(groupBy: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/workspaces/${id}/chat/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId: answer.toolId, query: answer.query, groupBy }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setGraphResult(data); setCategoryChoice(groupBy); setGraph(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Graph failed.'); }
    finally { setBusy(false); }
  }
  async function exportAll(format = 'xlsx') {
    if (runId) {
      // Same flow as other reports: save first, then export every row.
      const savedReportId = reportId || saved || await save();
      if (!savedReportId) return;
      const hidden = { ...hiddenResultColumns, ...(hiddenResultColumns['0'] ? {} : { 0: initial.hiddenColumns || [] }) };
      window.location.assign(`/api/workspaces/${id}/procedures/runs/${runId}/export?reportId=${savedReportId}&format=${format}&hidden=${encodeURIComponent(JSON.stringify(hidden))}`);
      return;
    }
    // Full export: every matching row, re-queried with the same approved
    // tool and plan as this answer.
    if (answer.toolId && answer.query !== undefined) {
      const savedReportId = reportId || saved || await save();
      if (!savedReportId) return;
      window.location.assign(`/api/workspaces/${id}/chat/export?toolId=${encodeURIComponent(answer.toolId)}&query=${encodeURIComponent(answer.query)}&reportId=${savedReportId}&hiddenColumns=${encodeURIComponent(JSON.stringify(hiddenColumns))}`);
      return;
    }
    await exportPage();
  }
  async function exportPage() {
    const cellValue = (value: unknown): string | number => value == null ? '' : typeof value === 'number' ? value : String(value);
    const sheets = (procedureSets || []).map((set, index) => {
      const hidden = hiddenResultColumns[String(index)] || (index === 0 ? initial.hiddenColumns || [] : []);
      const columns = set.columns.filter(column => !hidden.includes(column));
      return { name: `Result ${index + 1}`, headers: columns, rows: set.rows.map(row => columns.map(column => cellValue(row[column]))) };
    });
    if (answer.procedure) sheets.push({ name: 'Output parameters', headers: ['Parameter', 'Value'], rows: [...Object.entries(answer.procedure.output || {}).map(([name, value]) => [name, cellValue(value)]), ['Return code', cellValue(answer.procedure.returnValue)]] });
    const fileContent = answer.procedure && procedureSets ? buildWorkbookBase64(sheets) : buildXlsxBase64(visibleKeys, sourceRows.map(row => visibleKeys.map(key => cellValue(row[key]))));
    const fileName = `workspace-report-page-${answer.page || 1}.xlsx`;
    triggerDownload(fileName, base64ToBlob(fileContent, XLSX_MIME_TYPE));
    const reportId = saved || await save();
    if (!reportId) return;
    try {
      const response = await fetch('/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId, fileName, format: 'xlsx', fileContent }) });
      if (!response.ok) throw new Error('Could not save export history.');
    } catch { setError('Excel downloaded, but its export history could not be saved.'); }
  }
  async function page(next: number) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/workspaces/${id}/chat/page`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolId: answer.toolId,
          query: answer.query,
          page: next,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setAnswer((a) => ({ ...a, ...data, page: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Page failed.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (reportId) {
        const response = await fetch(`/api/reports/${reportId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenColumns: answer.procedure ? hiddenResultColumns['0'] || initial.hiddenColumns || [] : hiddenColumns, ...(answer.procedure ? { hiddenResultColumns, procedureActiveResult: activeResult, procedureGraphs, graphVisible: graph } : {}) }) });
        if (!response.ok) throw new Error('Report settings could not be saved.');
        setSaved(reportId);
        return reportId;
      }
      const r = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: answer.title || "Workspace Report",
          narrative: answer.narrative,
          sourceSessionId: answer.sessionId,
          topic: "workspace_tools",
          chartType: "none",
          data: {
            semanticQueryTable: {
              headers: keys,
              rows: sourceRows.map((row) =>
                keys.map((k) => (row[k] == null ? "" : String(row[k]))),
              ),
            },
            workspaceToolQuery: {
              workspaceId: id,
              toolId: answer.toolId,
              query: answer.query,
              page: answer.page || 1,
            },
            workspaceToolAnswer: {
              ...answer,
              hiddenColumns: answer.procedure ? hiddenResultColumns['0'] || initial.hiddenColumns || [] : hiddenColumns,
              ...(answer.procedure ? { hiddenResultColumns, procedureActiveResult: activeResult, procedureGraphs } : {}),
              page: answer.page || 1,
              workspaceId: id,
              graphVisible: graph,
              graphMetric: metric,
              graphCategory: category,
              graphResult,
            },
            graphVisible: graph,
          },
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.saved)
        throw new Error(data.error || "Report could not be saved.");
      setSaved(data.id);
      return data.id as number;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReportCard title={answer.title || "Report"}>
      <div className="flex flex-wrap items-center gap-2">
        <ColumnMenu columns={keys} hidden={hiddenColumns} onChange={next => { if (answer.procedure) setHiddenResultColumns(previous => ({ ...previous, [activeResult]: next })); else setHiddenColumns(next); setSaved(undefined); }}/>
        {procedureSets && procedureSets.length > 1 && <select aria-label="Report result table" className="h-9 max-w-full rounded-md border bg-white px-2 text-sm" value={activeResult} onChange={event => { setActiveResult(Number(event.target.value)); setProcedurePage(1); setSaved(undefined); }}>{procedureSets.map((set, index) => <option key={index} value={index}>Result {index + 1} · {set.rowCount.toLocaleString()} rows</option>)}</select>}
        {(answer.toolId || answer.procedure) && <Button size="sm" className="gap-2" disabled={busy || !!saved || (!!runId && run?.status !== 'completed')} onClick={save}><Save size={14} />{saved ? 'Saved' : busy ? 'Saving...' : 'Save Report'}</Button>}
        {answer.procedure && isReport && <div className="flex items-center gap-2 text-xs"><button type="button" title="Previous page" disabled={procedurePage <= 1} onClick={() => setProcedurePage(p => p - 1)}><ChevronLeft size={16}/></button>Page {procedurePage} of {pageCount}<button type="button" title="Next page" disabled={procedurePage >= (pageCount || 1)} onClick={() => setProcedurePage(p => p + 1)}><ChevronRight size={16}/></button></div>}
        <a href={`/reports?workspace=${encodeURIComponent(id)}${answer.sourceId ? `&source=${encodeURIComponent(answer.sourceId)}` : ''}`} className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50">Saved Reports</a>
        {(keys.length > 0 || answer.procedure) && <Button variant="outline" size="sm" className="gap-2" onClick={() => void exportAll()} disabled={busy || (!!runId && run?.status !== 'completed') || (!answer.procedure && !visibleKeys.length)}><Download size={14} />Export Excel</Button>}
        {runId && <Button variant="outline" size="sm" className="gap-2" disabled={busy || run?.status !== 'completed'} onClick={() => void exportAll('pdf')}><FileText size={14}/>Export PDF</Button>}
        {answer.toolId && isReport && (
          <>
            <button
              title="Previous page"
              disabled={busy || (answer.page || 1) <= 1}
              onClick={() => page((answer.page || 1) - 1)}
              className="rounded-md border p-2 disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-zinc-500">
              Page {(answer.page || 1).toLocaleString()}{pageCount ? ` of ${pageCount.toLocaleString()}` : ""}
            </span>
            <button
              title="Next page"
              disabled={busy || !answer.hasMore}
              onClick={() => page((answer.page || 1) + 1)}
              className="rounded-md border p-2 disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
        {((answer.mode === "aggregate" && metric && category) || (answer.mode === 'rows' && keys.length > 0) || (answer.procedure && keys.length > 0 && (!runId || run?.status === 'completed'))) && (
          <button
            title="Toggle graph of current result page"
            disabled={busy}
            onClick={() => {
              if (answer.procedure) { setGraph(g => !g); setSaved(undefined); }
              else if (answer.mode === 'rows' && !graphResult) generateGraph(keys.find((k) => !/(?:id|_sk|code)$/i.test(k)) || keys[0]);
              else setGraph((g) => !g);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-medium"
          >
            <ChartColumn size={16} /> {graph ? "Hide Graph" : "Generate Graph"}
          </button>
        )}
        {saved && (
          <a className="text-sm text-rose-700" href={`/reports/${saved}?workspace=${encodeURIComponent(id)}${answer.sourceId ? `&source=${encodeURIComponent(answer.sourceId)}` : ''}`}>
            Saved report
          </a>
        )}
      </div>
      {runId && running && <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700"><span>{run?.progress || 'Starting the report'}…</span><button type="button" onClick={cancelRun} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">Cancel</button></div>}
      {runId && run?.status === 'failed' && <p role="alert" className="text-sm text-red-700">{run.error}</p>}
      {runId && run?.status === 'cancelled' && <p role="status" className="text-sm text-zinc-600">{run.error || 'Report cancelled.'}</p>}
      {answer.procedure && <div className="space-y-2 text-sm"><p className="text-xs text-zinc-500">Return code: {procedureReturn ?? (running ? 'pending' : 'not provided')}</p>{Object.entries(procedureOutput || {}).length > 0 && <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(procedureOutput || {}).map(([name, value]) => <div key={name} className="min-w-0 border-b py-2"><dt className="break-all font-medium">{name}</dt><dd className="break-words text-zinc-600">{value == null ? 'NULL' : String(value)}</dd></div>)}</dl>}{!!answer.procedure.messages?.length && <details><summary className="cursor-pointer text-xs text-zinc-500">SQL Server messages</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{answer.procedure.messages.join('\n')}</pre></details>}</div>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {graph && answer.procedure && keys.length > 0 && (!runId || run?.status === 'completed') && <ProcedureGraph key={`${runId || answer.procedure.id}:${activeResult}`} workspaceId={id} runId={runId} resultIndex={activeResult} columns={keys} rows={sourceRows} initial={procedureGraphs[String(activeResult)]} onChange={settings => { setProcedureGraphs(previous => ({ ...previous, [activeResult]: settings })); setSaved(undefined); }}/>}
      {graph && answer.mode === 'rows' && graphResult && <div className="space-y-3">
        <label className="text-sm">Group by<select value={graphResult.category} disabled={busy} onChange={(e) => generateGraph(e.target.value)} className="ml-2 max-w-full rounded-md border p-2">{keys.map((k) => <option key={k}>{k}</option>)}</select></label>
        <p className="text-xs text-zinc-500">{graphResult.scope}{graphResult.hasMore ? ' Additional groups are not shown.' : ''}</p>
        <div className="overflow-x-auto"><div style={{ minWidth: Math.max(600, graphResult.rows.length * 90), height: 320 }}><ResponsiveContainer width="100%" height="100%"><BarChart data={graphResult.rows}><CartesianGrid vertical={false} /><XAxis dataKey={graphResult.category} interval={0} tick={{ fontSize: 11 }} tickFormatter={axisLabel} /><YAxis /><Tooltip /><Bar dataKey={graphResult.metric} fill="#be123c" /></BarChart></ResponsiveContainer></div></div>
      </div>}
      {graph && answer.mode === 'aggregate' && metric && category && (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Metric
              <select
                className="ml-2 rounded-md border p-2"
                value={metric}
                onChange={(e) => setMetricChoice(e.target.value)}
              >
                {metricKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Group by
              <select
                className="ml-2 rounded-md border p-2"
                value={category}
                onChange={(e) => setCategoryChoice(e.target.value)}
              >
                {categoryKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            Current result page · {metric} by {category}
          </p>
          <div className="overflow-x-auto">
            <div
              style={{
                minWidth: Math.max(600, answer.rows.length * 90),
                height: 320,
              }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={answer.rows}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey={category}
                    interval={0}
                    tick={{ fontSize: 11 }}
                    tickFormatter={axisLabel}
                  />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey={metric} fill="#be123c" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
      {!isReport && totalCount !== undefined && totalCount > displayRows.length && (
        <p className="text-xs text-zinc-500">
          Showing {displayRows.length.toLocaleString()} of {totalCount.toLocaleString()} rows. Save the report to browse every row, or use Export Excel to download all of them.
        </p>
      )}
      {isReport && totalCount !== undefined && (
        <p className="text-xs text-zinc-500">
          Rows {(((answer.procedure ? procedurePage : answer.page || 1) - 1) * REPORT_PAGE_SIZE + (displayRows.length ? 1 : 0)).toLocaleString()}–{(((answer.procedure ? procedurePage : answer.page || 1) - 1) * REPORT_PAGE_SIZE + displayRows.length).toLocaleString()} of {totalCount.toLocaleString()}
        </p>
      )}
      <div className="max-h-[360px] overflow-auto rounded-md border border-zinc-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              {visibleKeys.map((k) => (
                <th key={k} title={k} className="whitespace-nowrap p-3">
                  {columnLabel(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, j) => (
              <tr key={j} className="border-t">
                {visibleKeys.map((k) => (
                  <td key={k} className="max-w-80 break-words p-3">
                    {row[k] == null ? "" : String(row[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleKeys.length && <p className="p-4 text-sm text-zinc-500">All columns are hidden.</p>}
      </div>
    </ReportCard>
  );
}

/** "dbo.CustomerMaster:NetMRC" → "Net MRC"; "total_net_mrc" → "Total net mrc". */
function columnLabel(key: string) {
  const name = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
  const spaced = name.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
