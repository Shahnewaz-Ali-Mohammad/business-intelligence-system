'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { FileSpreadsheet, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { getReportTable, stripTotalsRow } from '@/lib/dashboard/report-table';
import type { ChartSpec } from '@/lib/dashboard/chart-spec';
import { AutoReportChart } from '@/components/dashboard/charts/auto-report-chart';
import { ChartErrorBoundary } from '@/components/dashboard/charts/chart-error-boundary';
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, triggerDownload } from '@/lib/download';
import type { DashboardData } from '@/lib/dashboard/metrics';

type ReportRow = {
  id: number;
  title: string;
  narrative: string;
  topic: string | null;
  chart_type: 'bar' | 'line' | 'pie' | 'donut' | 'none' | null;
  filters: { days: number; region: string | null } | null;
  tables_used: string[] | null;
  data: DashboardData;
  chart_spec: ChartSpec | null;
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
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [chartSpec, setChartSpec] = useState<ChartSpec | null>(null);
  const [chartDirty, setChartDirty] = useState(false);
  const [chartSaveState, setChartSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    fetch(`/api/reports/${params.id}`)
      .then((res) => res.json())
      .then((body: { report: ReportRow | null }) => setReport(body.report))
      .catch(() => setReport(null));
  }, [params.id]);

  // Reports saved before chart persistence existed simply have
  // chart_spec === null -- by the user's explicit call, that's NOT treated
  // as "regenerate one on the fly." An old report never had a chart saved
  // for it, so there is nothing to show; chartSpec just stays null and the
  // Chart tab honestly says graphical data doesn't exist for it, instead of
  // silently fabricating a chart the user never saved or reviewed.
  useEffect(() => {
    if (!report) return;
    if (chartSpec) return;
    if (report.chart_spec) setChartSpec(report.chart_spec);
  }, [report, chartSpec]);

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

  async function handleSaveChart() {
    if (!report || !chartSpec) return;
    setChartSaveState('saving');
    try {
      const res = await fetch(`/api/reports/${report.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: report.title,
          narrative: report.narrative,
          topic: report.topic,
          chartType: report.chart_type,
          filters: report.filters,
          tablesUsed: report.tables_used,
          data: report.data,
          chartSpec,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setChartSaveState('saved');
      setChartDirty(false);
      setReport({ ...report, chart_spec: chartSpec });
    } catch (err) {
      console.error('Saving chart edits failed:', err);
      setChartSaveState('error');
    }
  }

  if (report === undefined) {
    return (
      <WorkspacePage active="Reports" title="Loading report..." subtitle="">
        <p className="text-sm text-slate-500">Loading...</p>
      </WorkspacePage>
    );
  }

  if (report === null) {
    return (
      <WorkspacePage active="Reports" title="Report not found" subtitle="">
        <p className="text-sm text-slate-500">
          This report does not exist, or was saved by a different account. Sign in with the account that generated it.
        </p>
      </WorkspacePage>
    );
  }

  const data = report.data;
  const table = getReportTable(report.topic, data, report.chart_type);

  async function handleExportExcel() {
    if (exporting) return;
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
        <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-5 shadow-sm">
          <h2 className="text-base font-bold text-blue-950">Insight Summary</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-blue-900">{report.narrative}</p>
          {report.tables_used && report.tables_used.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-blue-100/80 pt-3">
              <span className="text-xs font-medium text-blue-900/60">Grounded in:</span>
              {report.tables_used.map((tableName) => (
                <span
                  key={tableName}
                  className="rounded-md border border-blue-200 bg-white/70 px-1.5 py-0.5 text-[11px] font-medium text-blue-900"
                >
                  {tableName}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <div className="flex items-center justify-between">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setView('table')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                view === 'table' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Table
            </button>
            <button
              type="button"
              onClick={() => setView('chart')}
              disabled={!chartSpec || chartSpec.groups.length === 0}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                view === 'chart' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Chart
            </button>
          </div>

          {view === 'chart' && chartSpec && chartSpec.groups.length > 0 ? (
            <div className="flex items-center gap-2">
              {chartSaveState === 'saved' && !chartDirty ? (
                <span className="text-xs font-medium text-emerald-600">Chart saved</span>
              ) : null}
              {chartSaveState === 'error' ? (
                <span className="text-xs font-medium text-red-600">Save failed, try again</span>
              ) : null}
              <Button
                variant="outline"
                className="gap-2"
                onClick={handleSaveChart}
                disabled={!chartDirty || chartSaveState === 'saving'}
              >
                <Save size={16} />
                {chartSaveState === 'saving' ? 'Saving...' : 'Save chart'}
              </Button>
            </div>
          ) : null}
        </div>

        {view === 'table' ? (
          <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    {table.headers.map((header, i) => (
                      <th key={`${header}-${i}`} className="px-5 py-3 font-semibold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {table.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className="px-5 py-3 text-slate-700">
                          {typeof cell === 'number' ? cell.toLocaleString('en-US') : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : chartSpec && chartSpec.groups.length > 0 ? (
          <ChartErrorBoundary key={report.id}>
            <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
              <AutoReportChart
                table={{ headers: table.headers, rows: stripTotalsRow(table) }}
                spec={chartSpec}
                onSpecChange={(updated) => {
                  setChartSpec(updated);
                  setChartDirty(true);
                  setChartSaveState('idle');
                }}
              />
            </section>
          </ChartErrorBoundary>
        ) : (
          <p className="text-sm text-slate-500">Graphical data does not exist for this report.</p>
        )}

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
