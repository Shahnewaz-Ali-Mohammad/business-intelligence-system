'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';

type Row = { id: number; title: string; workspace: string; workspaceId: string; blocks: number; updatedAt: string };

export default function DesignedReportsPage() { return <Suspense fallback={null}><DesignedReports /></Suspense>; }

function DesignedReports() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    fetch('/api/designs').then((r) => r.json()).then((d) => { setRows((d.designs || []).filter((x: Row) => x.blocks > 0)); if (d.notInstalled) setNote('The Report Designer is not installed yet. Import database/report-designer-migration.sql in phpMyAdmin.'); if (d.error) setNote(d.error); }).catch(() => setRows([]));
  }, []);
  return (
    <WorkspacePage active="Design report" title="Designed reports" subtitle="Reports built on the canvas from a conversation. Open one to keep designing." scroll
      action={<Link href="/reports" className="text-sm font-medium text-rose-700 hover:underline">Saved chat reports</Link>}>
      {note && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{note}</p>}
      {rows === null ? <p className="text-sm text-zinc-500">Loading…</p> : !rows.length ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center">
          <LayoutTemplate className="text-zinc-300" size={36} />
          <p className="font-semibold">No designed reports yet</p>
          <p className="max-w-md text-sm text-zinc-500">Open a workspace and press <b>Design report</b> in the left menu.</p>
          
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <Link key={r.id} href={`/reports/designed/${r.id}?workspace=${encodeURIComponent(r.workspaceId)}`} className="group rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-rose-200 hover:shadow-md">
              <div className="mb-4 grid h-24 grid-cols-3 gap-1.5 rounded-lg bg-zinc-50 p-2">
                {Array.from({ length: Math.min(6, Math.max(3, r.blocks)) }).map((_, i) => <div key={i} className={`rounded ${i % 3 === 0 ? 'col-span-2 bg-rose-100' : 'bg-zinc-200/70'}`} />)}
              </div>
              <p className="truncate font-semibold group-hover:text-rose-800">{r.title}</p>
              <p className="mt-1 text-xs text-zinc-500">{r.workspace} · {r.blocks} blocks · {new Date(r.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
            </Link>
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}
