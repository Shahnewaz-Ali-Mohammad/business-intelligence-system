'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, FileSpreadsheet, LogIn, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { useAuth } from '@/components/auth/auth-provider';
import { XLSX_MIME_TYPE, base64ToBlob, triggerDownload } from '@/lib/download';

type ExportRow = {
  id: number;
  report_id: number | null;
  file_name: string;
  format: string;
  created_at: string;
};

export default function ExportsPage() {
  const { user, loading: authLoading } = useAuth();
  const [exports, setExports] = useState<ExportRow[] | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    fetch('/api/exports')
      .then((res) => res.json())
      .then((body: { exports: ExportRow[] }) => setExports(body.exports))
      .catch(() => setExports([]));
  }, [authLoading, user]);

  async function handleDownload(item: ExportRow) {
    setDownloadingId(item.id);
    try {
      const res = await fetch(`/api/exports/${item.id}`);
      const body: { export: { file_name: string; format: string; file_content: string | null } | null } =
        await res.json();
      if (!body.export || !body.export.file_content) return;
      triggerDownload(body.export.file_name, base64ToBlob(body.export.file_content, XLSX_MIME_TYPE));
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Remove this export from your history?')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/exports/${id}`, { method: 'DELETE' });
      if (res.ok) setExports((prev) => prev?.filter((item) => item.id !== id) ?? prev);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <WorkspacePage active="Exports" title="Exports" subtitle="Download history for generated Excel reports." scroll>
      {!authLoading && !user ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <LogIn size={22} className="text-slate-400" />
          <p className="text-sm text-slate-500">Sign in to see your export history.</p>
          <Link href="/login" className="text-sm font-semibold text-blue-600 hover:underline">
            Sign in / Create account
          </Link>
        </div>
      ) : exports === null ? (
        <p className="text-sm text-slate-500">Loading export history...</p>
      ) : exports.length === 0 ? (
        <div className="rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <Download size={22} className="mx-auto mb-3 text-slate-400" />
          <p className="text-sm text-slate-500">
            No exports yet. Open a report and click Export Excel to download a file -- it will show up here.
          </p>
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)]">
          {exports.map((item) => (
            <div key={item.id} className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 last:border-b-0">
              <FileSpreadsheet size={20} className="text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{item.file_name}</p>
                <p className="text-sm text-slate-500">Excel · {new Date(item.created_at).toLocaleString()}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => handleDownload(item)}
                disabled={downloadingId === item.id}
              >
                <Download size={15} />
                {downloadingId === item.id ? 'Downloading...' : 'Download'}
              </Button>
              <button
                type="button"
                onClick={() => handleDelete(item.id)}
                disabled={deletingId === item.id}
                aria-label="Remove export"
                className="rounded-md p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </section>
      )}
    </WorkspacePage>
  );
}
