"use client";
import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Save,
  ChartColumn,
  Download,
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
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, triggerDownload } from '@/lib/download';
export type WorkspaceAnswer = {
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
  sourceId?: string;
  graphResult?: { rows: Record<string, unknown>[]; category: string; metric: string; hasMore: boolean; scope: string };
  totalCount?: number;
};

// Chat shows at most this many rows; the saved report pages through all.
const CHAT_ROW_CAP = 200;
const REPORT_PAGE_SIZE = 100;
export function WorkspaceResult({
  id,
  initial,
  variant = "chat",
}: {
  id: string;
  initial: WorkspaceAnswer;
  variant?: "chat" | "report";
}) {
  const isReport = variant === "report";
  const [answer, setAnswer] = useState<WorkspaceAnswer>(() => {
    if (isReport) {
      // The report pages 100 rows at a time from the database.
      const page = initial.page || 1;
      if (page === 1 && initial.rows.length > REPORT_PAGE_SIZE)
        return { ...initial, rows: initial.rows.slice(0, REPORT_PAGE_SIZE), hasMore: true };
      return initial;
    }
    return { ...initial, rows: initial.rows.slice(0, CHAT_ROW_CAP) };
  });
  const totalCount = typeof answer.totalCount === "number" ? answer.totalCount : undefined;
  const pageCount = totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / REPORT_PAGE_SIZE)) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<number>();
  const [graph, setGraph] = useState(initial.graphVisible || false);
  const [metricChoice, setMetricChoice] = useState("");
  const [categoryChoice, setCategoryChoice] = useState("");
  const [graphResult, setGraphResult] = useState(initial.graphResult);
  const keys = Object.keys(answer.rows[0] || {});
  const numericKeys = keys.filter(
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
  async function exportAll() {
    // Full export: every matching row, re-queried with the same approved
    // tool and plan as this answer.
    if (answer.toolId && answer.query !== undefined) {
      window.location.href = `/api/workspaces/${id}/chat/export?toolId=${encodeURIComponent(answer.toolId)}&query=${encodeURIComponent(answer.query)}`;
      return;
    }
    await exportPage();
  }
  async function exportPage() {
    const fileContent = buildXlsxBase64(keys, answer.rows.map((row) => keys.map((key) => row[key] == null ? '' : typeof row[key] === 'number' ? row[key] as number : String(row[key]))));
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
              rows: answer.rows.map((row) =>
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
              page: 1,
              workspaceId: id,
              graphVisible: graph,
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
        {answer.toolId && <Button size="sm" className="gap-2" disabled={busy || !!saved} onClick={save}><Save size={14} />{saved ? 'Saved' : busy ? 'Saving...' : 'Save Report'}</Button>}
        <a href={`/reports?workspace=${encodeURIComponent(id)}${answer.sourceId ? `&source=${encodeURIComponent(answer.sourceId)}` : ''}`} className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50">Saved Reports</a>
        {keys.length > 0 && <Button variant="outline" size="sm" className="gap-2" onClick={exportAll} disabled={busy}><Download size={14} />Export Excel</Button>}
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
        {((answer.mode === "aggregate" && metric && category) || (answer.mode === 'rows' && keys.length > 0)) && (
          <button
            title="Toggle graph of current result page"
            disabled={busy}
            onClick={() => {
              if (answer.mode === 'rows' && !graphResult) generateGraph(keys.find((k) => !/(?:id|_sk|code)$/i.test(k)) || keys[0]);
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
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {graph && answer.mode === 'rows' && graphResult && <div className="space-y-3">
        <label className="text-sm">Group by<select value={graphResult.category} disabled={busy} onChange={(e) => generateGraph(e.target.value)} className="ml-2 max-w-full rounded-md border p-2">{keys.map((k) => <option key={k}>{k}</option>)}</select></label>
        <p className="text-xs text-zinc-500">{graphResult.scope}{graphResult.hasMore ? ' Additional groups are not shown.' : ''}</p>
        <div className="overflow-x-auto"><div style={{ minWidth: Math.max(600, graphResult.rows.length * 90), height: 320 }}><ResponsiveContainer width="100%" height="100%"><BarChart data={graphResult.rows}><CartesianGrid vertical={false} /><XAxis dataKey={graphResult.category} interval={0} tick={{ fontSize: 11 }} /><YAxis /><Tooltip /><Bar dataKey={graphResult.metric} fill="#be123c" /></BarChart></ResponsiveContainer></div></div>
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
      {!isReport && totalCount !== undefined && totalCount > answer.rows.length && (
        <p className="text-xs text-zinc-500">
          Showing {answer.rows.length.toLocaleString()} of {totalCount.toLocaleString()} rows. Save the report to browse every row, or use Export Excel to download all of them.
        </p>
      )}
      {isReport && totalCount !== undefined && (
        <p className="text-xs text-zinc-500">
          Rows {(((answer.page || 1) - 1) * REPORT_PAGE_SIZE + (answer.rows.length ? 1 : 0)).toLocaleString()}–{(((answer.page || 1) - 1) * REPORT_PAGE_SIZE + answer.rows.length).toLocaleString()} of {totalCount.toLocaleString()}
        </p>
      )}
      <div className="max-h-[360px] overflow-auto rounded-md border border-zinc-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              {keys.map((k) => (
                <th key={k} className="whitespace-nowrap p-3">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {answer.rows.map((row, j) => (
              <tr key={j} className="border-t">
                {keys.map((k) => (
                  <td key={k} className="max-w-80 break-words p-3">
                    {row[k] == null ? "" : String(row[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}
