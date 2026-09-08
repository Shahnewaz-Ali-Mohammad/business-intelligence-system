'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { RegionRevenueChart } from '@/components/dashboard/charts/region-revenue-chart';
import { RevenueTrendChart } from '@/components/dashboard/charts/revenue-trend-chart';
import { TopProductsTable } from '@/components/dashboard/tables/top-products-table';
import type { DashboardData } from '@/lib/dashboard/metrics';

type ReportRow = {
  id: number;
  title: string;
  narrative: string;
  filters: { days: number; region: string | null } | null;
  tables_used: string[] | null;
  data: DashboardData;
  created_at: string;
};

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>();
  const [report, setReport] = useState<ReportRow | null | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/reports/${params.id}`)
      .then((res) => res.json())
      .then((body: { report: ReportRow | null }) => setReport(body.report))
      .catch(() => setReport(null));
  }, [params.id]);

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

  return (
    <WorkspacePage
      active="Reports"
      title={report.title}
      subtitle={`Saved from the chat workspace on ${new Date(report.created_at).toLocaleString()}`}
      action={
        <div className="hidden gap-2 md:flex">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() =>
              downloadCsv(`${report.title.toLowerCase().replace(/\s+/g, '-')}.csv`, [
                ['Metric', 'Value', 'Detail'],
                ...data.kpis.map((kpi) => [kpi.label, kpi.value, kpi.detail]),
              ])
            }
          >
            <FileSpreadsheet size={16} />
            Export CSV
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <section className="rounded-xl border border-blue-100 bg-blue-50/70 p-5 shadow-sm">
            <h2 className="text-base font-bold text-blue-950">Insight Summary</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-blue-900">{report.narrative}</p>
          </section>
          <div className="grid gap-5 xl:grid-cols-2">
            <RegionRevenueChart data={data} />
            <RevenueTrendChart data={data} />
          </div>
          <TopProductsTable data={data} />
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
            <h2 className="text-base font-bold">Session Context</h2>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Window</span>
                <span className="font-medium">{report.filters?.days ?? 30} days</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Region</span>
                <span className="font-medium">{report.filters?.region ?? 'All regions'}</span>
              </div>
            </div>
            {report.tables_used && report.tables_used.length ? (
              <div className="mt-4 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                <Download size={12} className="text-slate-400" />
                {report.tables_used.map((table) => (
                  <span
                    key={table}
                    className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
                  >
                    {table}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        </aside>
      </div>
    </WorkspacePage>
  );
}
