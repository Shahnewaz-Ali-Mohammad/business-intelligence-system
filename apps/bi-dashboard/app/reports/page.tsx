'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, LogIn, Trash2 } from 'lucide-react';
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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const pageSize = 6; // standardized with Sessions list (was 5)

  const loadPage = useCallback((targetPage: number) => {
    setReports(null);
    fetch(`/api/reports?page=${targetPage}`)
      .then((res) => res.json())
      .then((body: { reports: ReportRow[]; total: number; page: number }) => {
        setReports(body.reports);
        setTotal(body.total);
        setPage(body.page);
      })
      .catch(() => setReports([]));
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    fetch('/api/reports?page=1')
      .then((res) => res.json())
      .then((body: { reports: ReportRow[]; total: number; page: number }) => {
        if (cancelled) return;
        setReports(body.reports);
        setTotal(body.total);
        setPage(body.page);
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  async function handleDelete(id: number) {
    if (!confirm('Delete this report? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const remainingOnPage = (reports?.length ?? 1) - 1;
        const nextPage = remainingOnPage === 0 && page > 1 ? page - 1 : page;
        loadPage(nextPage);
      }
    } finally {
      setDeletingId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <WorkspacePage active="Reports" title="Reports" subtitle="Generated reports saved from chat sessions." scroll>
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
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {reports.map((report) => (
              <section
                key={report.id}
                className="relative rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]"
              >
                <button
                  type="button"
                  onClick={() => handleDelete(report.id)}
                  disabled={deletingId === report.id}
                  aria-label="Delete report"
                  className="absolute right-4 top-4 rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                </button>
                <BarChart3 size={20} className="mb-4 text-teal-600" />
                <h2 className="pr-6 font-bold text-slate-950">{report.title}</h2>
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

          {totalPages > 1 ? (
            <div className="mt-6 mb-2 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => loadPage(page - 1)}
                disabled={page <= 1}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => loadPage(page + 1)}
                disabled={page >= totalPages}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
        </>
      )}
    </WorkspacePage>
  );
}
