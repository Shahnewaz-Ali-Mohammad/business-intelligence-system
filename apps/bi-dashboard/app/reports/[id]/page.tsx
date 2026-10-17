'use client';

import { useEffect, useRef, useState } from 'react';
import { ClientPaginatedTable, PaginatedListTable, isListTopic, listExportUrl } from '@/components/dashboard/tables/paginated-list-table';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FileSpreadsheet, MessageSquare, Trash2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { getReportTable } from '@/lib/dashboard/report-table';
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, triggerDownload } from '@/lib/download';
import type { DashboardData } from '@/lib/dashboard/metrics';
import type { ChartSpec } from '@/lib/dashboard/chart-spec';
import type { ReportGraphSpec } from '@/lib/dashboard/report-graph';
import { reportGraphSource } from '@/lib/dashboard/report-graph';
import { ReportGraph } from '@/components/dashboard/charts/report-graph';
import {WorkspaceResult,type WorkspaceAnswer} from '@/components/data-sources/workspace-result';

type ReportRow = {
  id: number;
  title: string;
  narrative: string;
  topic: string | null;
  chart_type: 'bar' | 'line' | 'pie' | 'donut' | 'none' | null;
  filters: { days: number; region: string | null } | null;
  tables_used: string[] | null;
  data: DashboardData;
  source_session_id: number | null;
  created_at: string;
  chart_spec: ChartSpec | null;
};

type SiblingReport = {
  id: number;
  title: string;
  created_at: string;
};


async function logExport(reportId: number, fileName: string, fileContent: string) {
  try {
    const res = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, fileName, format: 'xlsx', fileContent }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('Saving to export history failed:', res.status, text);
      alert(`The file downloaded, but saving it to your Exports history failed (${res.status}). Open the browser console and the terminal running "npm run dev" for details.`);
    }
  } catch (error) {
    console.error('Saving to export history failed:', error);
    alert('The file downloaded, but saving it to your Exports history failed (network error). Open the browser console for details.');
  }
}

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<ReportRow | null | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [siblingReports, setSiblingReports] = useState<SiblingReport[]>([]);
  const [graphDirty, setGraphDirty] = useState(false);
  const [savingGraph, setSavingGraph] = useState(false);
  const [graphSaveError, setGraphSaveError] = useState<string | null>(null);
  const graphRevision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reports/${params.id}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((body: { report: ReportRow | null; siblingReports?: SiblingReport[] }) => {
        if (controller.signal.aborted) return;
        setReport(body.report);
        setSiblingReports(body.siblingReports ?? []);
      })
      .catch(() => { if (!controller.signal.aborted) setReport(null); });
    return () => controller.abort();
  }, [params.id]);

  async function handleDelete() {
    if (!report) return;
    if (!confirm('Delete this report? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/reports/${report.id}`, { method: 'DELETE' });
      if (res.ok) router.push('/reports');
    } finally {
      setDeleting(false);
    }
  }

  function changeGraph(spec: ReportGraphSpec | null) {
    graphRevision.current += 1;
    setReport((current) => current ? { ...current, chart_spec: { ...current.chart_spec, groups: current.chart_spec?.groups || [], reportGraph: spec } } : current);
    setGraphDirty(true); setGraphSaveError(null);
  }
  async function saveGraph() {
    if (!report) return;
    const revision = graphRevision.current;
    setSavingGraph(true); setGraphSaveError(null);
    try {
      const res = await fetch(`/api/reports/${report.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chartSpec: report.chart_spec }) });
      if (!res.ok) throw new Error('Could not save graph settings.');
      if (graphRevision.current === revision) setGraphDirty(false);
    } catch (e) { setGraphSaveError(e instanceof Error ? e.message : 'Could not save graph settings.'); }
    finally { setSavingGraph(false); }
  }


  if (report === undefined) {
    return (
      <WorkspacePage active="Reports" title="Loading report..." subtitle="">
        <p className="text-sm text-zinc-500">Loading...</p>
      </WorkspacePage>
    );
  }

  if (report === null) {
    return (
      <WorkspacePage active="Reports" title="Report not found" subtitle="">
        <p className="text-sm text-zinc-500">
          This report does not exist, or was saved by a different account. Sign in with the account that generated it.
        </p>
      </WorkspacePage>
    );
  }

  const data = report.data;
  const table = getReportTable(report.topic, data, report.chart_type);

  async function handleExportExcel() {
    if (exporting) return;
    // FIX 2026-10-04: same fix as the chat panel's own handleExportArtifact
    // -- a saved ticket_list/customer_list report's `data` is whatever got
    // captured at save time, capped at 5,000 rows (see getTicketList's own
    // comment on that real cap, and SAVE_ROW_CAP in report-save.ts on top
    // of it). Building Export Excel from that snapshot can never produce
    // more rows than were saved. These two topics now go to a dedicated
    // server route that re-queries and streams every matching row fresh
    // from the database into a real .xlsx, with no cap at all.
    // 2026-10-04: list reports export EVERY matching row server-side, with
    // the same filters the report was built from.
    if (isListTopic(report!.topic, report!.data)) {
      const url = listExportUrl(report!.topic, report!.data);
      if (url) {
        window.location.href = url;
        return;
      }
    }
    setExporting(true);
    try {
      const fileName = `${report!.title.toLowerCase().replace(/\s+/g, '-')}.xlsx`;
      const base64 = buildXlsxBase64(table.headers, table.rows);
      triggerDownload(fileName, base64ToBlob(base64, XLSX_MIME_TYPE));
      await logExport(report!.id, fileName, base64);
    } finally {
      setExporting(false);
    }
  }

  const toolAnswer=(report.data as unknown as {workspaceToolAnswer?:WorkspaceAnswer & {workspaceId:string}}).workspaceToolAnswer;
  if(toolAnswer) return <WorkspacePage active="Reports" title={report.title} subtitle="Saved database report" scroll><p className="mb-4 text-sm text-zinc-600">{report.narrative}</p><Link className="mb-4 inline-flex text-sm text-rose-700" href={`/data-sources/${toolAnswer.workspaceId}/chat${report.source_session_id?`?session=${report.source_session_id}`:''}`}>Continue in workspace chat</Link><WorkspaceResult id={toolAnswer.workspaceId} initial={toolAnswer} variant="report" reportId={Number(report.id)}/></WorkspacePage>;
  return (
    <WorkspacePage
      active="Reports"
      title={report.title}
      subtitle={`Saved from the chat workspace on ${new Date(report.created_at).toLocaleString()}`}
      scroll
      action={
        <div className="hidden gap-2 md:flex">
          <Button variant="outline" className="gap-2" onClick={handleExportExcel} disabled={exporting}>
            <FileSpreadsheet size={16} />
            {exporting ? 'Exporting...' : 'Export Excel'}
          </Button>
          <Button variant="outline" className="gap-2 text-red-600 hover:bg-red-50" onClick={handleDelete} disabled={deleting}>
            <Trash2 size={16} />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="rounded-lg border border-rose-100 bg-rose-50/70 p-5 shadow-sm">
          <h2 className="text-base font-bold text-rose-950">Insight Summary</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-rose-900">{report.narrative}</p>
          {report.tables_used && report.tables_used.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-rose-100/80 pt-3">
              <span className="text-xs font-medium text-rose-900/60">Grounded in:</span>
              {report.tables_used.map((tableName) => (
                <span
                  key={tableName}
                  className="rounded-md border border-rose-200 bg-white/70 px-1.5 py-0.5 text-[11px] font-medium text-rose-900"
                >
                  {tableName}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        {report.source_session_id ? (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <MessageSquare size={16} className="text-zinc-400" />
              <span>Want to ask a follow-up or change something? Continue the real conversation this report came from.</span>
            </div>
            <Link
              href={`/chat?session=${report.source_session_id}`}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-rose-700 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-rose-800"
            >
              <MessageSquare size={14} />
              Continue in chat
            </Link>
          </section>
        ) : null}

        {siblingReports.length > 0 ? (
          <section className="rounded-lg border border-zinc-200/80 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-bold text-zinc-800">Other reports from this chat</h2>
            <p className="mt-1 text-xs text-zinc-400">Other reports saved from the same conversation, newest first.</p>
            <ul className="mt-3 space-y-1.5">
              {siblingReports.map((sibling) => (
                <li key={sibling.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/reports/${sibling.id}`} className="text-rose-700 hover:underline">
                    {sibling.title}
                  </Link>
                  <span className="shrink-0 text-xs text-zinc-400">{new Date(sibling.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="min-w-0 bg-white px-4 py-4 sm:px-5">
          <ReportGraph key={report.id} source={reportGraphSource(data)} title={report.title} spec={report.chart_spec?.reportGraph} onChange={changeGraph} />
          {graphDirty && <Button size="sm" variant="outline" className="mt-3 gap-2" disabled={savingGraph} onClick={saveGraph}><Save size={14} />{savingGraph ? 'Saving...' : 'Save graph'}</Button>}
          {graphSaveError && <p role="alert" className="mt-2 text-sm text-red-600">{graphSaveError}</p>}
        </div>

          <section className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm">
            {/* FIX 2026-10-01: real gap found live, same bug class as the
                chat panel's inline table (see chat-workspace.tsx's own
                comment) -- this page unconditionally mapped EVERY row of
                table.rows into real <tr> elements with no cap at all. A
                saved report's row-level data can now be up to 2,000 rows
                (Save Report's own cap, see app/api/reports/route.ts), so
                opening a saved ticket/customer list report always mounted
                up to 2,000 rows at once, no preview, no pagination. Same
                fix: a small default preview, an explicit expand action,
                and a sane inline ceiling beyond which Export Excel is the
                right tool, not the on-screen table. */}
            {isListTopic(report.topic, report.data) ? (
              <PaginatedListTable topic={report.topic} data={report.data} />
            ) : (
              // 2026-10-04: every saved table pages through ALL its rows.
              <ClientPaginatedTable headers={table.headers} rows={table.rows} />
            )}
          </section>

        <div className="flex flex-col gap-2 md:hidden">
          <Button variant="outline" className="w-full gap-2" onClick={handleExportExcel} disabled={exporting}>
            <FileSpreadsheet size={16} />
            {exporting ? 'Exporting...' : 'Export Excel'}
          </Button>
          <Button variant="outline" className="w-full gap-2 text-red-600 hover:bg-red-50" onClick={handleDelete} disabled={deleting}>
            <Trash2 size={16} />
            {deleting ? 'Deleting...' : 'Delete Report'}
          </Button>
        </div>
      </div>
    </WorkspacePage>
  );
}
