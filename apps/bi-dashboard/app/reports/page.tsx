'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BarChart3, LogIn } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { useAuth } from '@/components/auth/auth-provider';

type ReportRow = {
  id: number;
  title: string;
  narrative: string;
  created_at: string;
};

export default function ReportsPage() {
  const { user, loading: authLoading } = useAuth();
  const [reports, setReports] = useState<ReportRow[] | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    fetch('/api/reports')
      .then((res) => res.json())
      .then((body: { reports: ReportRow[] }) => setReports(body.reports))
      .catch(() => setReports([]));
  }, [authLoading, user]);

  return (
    <WorkspacePage active="Reports" title="Reports" subtitle="Generated reports saved from chat sessions.">
      {!authLoading && !user ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <LogIn size={22} className="text-slate-400" />
          <p className="text-sm text-slate-500">Sign in to see reports you have generated and saved.</p>
          <Link href="/login" className="text-sm font-semibold text-blue-600 hover:underline">
            Sign in / Create account
          </Link>
        </div>
      ) : reports === null ? (
        <p className="text-sm text-slate-500">Loading your saved reports...</p>
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-slate-500">
            No reports yet. Ask the chat assistant for a report (e.g. &quot;Generate revenue report&quot;) and it will be saved here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          {reports.map((report) => (
            <section
              key={report.id}
              className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]"
            >
              <BarChart3 size={20} className="mb-4 text-teal-600" />
              <h2 className="font-bold text-slate-950">{report.title}</h2>
              <p className="mt-2 line-clamp-3 min-h-14 text-sm text-slate-500">{report.narrative}</p>
              <p className="mt-2 text-xs text-slate-400">{new Date(report.created_at).toLocaleString()}</p>
              <div className="mt-4">
                <Link
                  href={`/reports/${report.id}`}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-blue-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
                >
                  Open
                </Link>
              </div>
            </section>
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}
