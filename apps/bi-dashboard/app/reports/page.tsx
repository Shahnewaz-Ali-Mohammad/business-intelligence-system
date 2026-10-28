'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BarChart3, ChevronLeft, ChevronRight, LogIn, Trash2 } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { useAuth } from '@/components/auth/auth-provider';

type ReportRow = {
  id: number;
  title: string;
  narrative: string;
  created_at: string;
  parent_report_id: number | null;
};

export default function ReportsPage() { return <Suspense fallback={null}><ScopedReports /></Suspense>; }
function ScopedReports() { const search = useSearchParams(); return <ReportList key={search.toString()} />; }
function ReportList() {
  const search = useSearchParams();
  const scope = new URLSearchParams();
  if (search.get('workspace')) scope.set('workspace', search.get('workspace')!);
  if (search.get('source')) scope.set('source', search.get('source')!);
  const scopeQuery = scope.toString();
  const { user, loading: authLoading } = useAuth();
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const pageSize = 6; // standardized with Sessions list (was 5)

  const loadPage = useCallback((targetPage: number) => {
    setReports(null);
    fetch(`/api/reports?page=${targetPage}&${scopeQuery}`)
      .then((res) => res.json())
      .then((body: { reports: ReportRow[]; total: number; page: number }) => {
        setReports(body.reports);
        setTotal(body.total);
        setPage(body.page);
      })
      .catch(() => setReports([]));
  }, [scopeQuery]);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    fetch(`/api/reports?page=1&${scopeQuery}`)
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
  }, [authLoading, user, scopeQuery]);

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
    <WorkspacePage active="Reports" title="Reports" subtitle="Generated reports saved from chat sessions." scroll action={<Link href="/reports/designed" className="inline-flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-3.5 text-sm font-semibold text-zinc-700 shadow-sm hover:border-rose-200 hover:text-rose-800">Designed reports</Link>}>
      {!authLoading && !user ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-zinc-200/80 bg-white p-10 text-center shadow-sm">
          <LogIn size={22} className="text-zinc-400" />
          <p className="text-sm text-zinc-500">Sign in to see reports you have generated and saved.</p>
          <Link href="/login" className="text-sm font-semibold text-rose-700 hover:underline">
            Sign in / Create account
          </Link>
        </div>
      ) : reports === null ? (
        <p className="text-sm text-zinc-500">Loading your saved reports...</p>
      ) : reports.length === 0 ? (
        <div className="rounded-lg border border-zinc-200/80 bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-zinc-500">
            No reports yet. Ask the chat assistant for a report (e.g. &quot;Generate revenue report&quot;) and it will be saved here.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {reports.map((report) => (
              <section
                key={report.id}
                className="relative rounded-lg border border-zinc-200/80 bg-white p-5 shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => handleDelete(report.id)}
                  disabled={deletingId === report.id}
                  aria-label="Delete report"
                  className="absolute right-4 top-4 rounded-md p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                </button>
                <BarChart3 size={20} className="mb-4 text-rose-700" />
                <h2 className="pr-6 font-bold text-zinc-800">{report.title}</h2>
                <p className="mt-2 line-clamp-3 min-h-14 text-sm text-zinc-500">{report.narrative}</p>
                <p className="mt-2 text-xs text-zinc-400">{new Date(report.created_at).toLocaleString()}</p>
                <div className="mt-4">
                  <Link
                    href={`/reports/${report.id}?${scopeQuery}`}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-rose-700 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-rose-800"
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 shadow-sm transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-zinc-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => loadPage(page + 1)}
                disabled={page >= totalPages}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 shadow-sm transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
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
