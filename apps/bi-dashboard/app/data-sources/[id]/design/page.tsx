'use client';
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** "Design report" in a workspace: starts a new designed report and opens it. */
export default function NewDesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    fetch(`/api/workspaces/${encodeURIComponent(id)}/designs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not start a report.'); router.replace(`/reports/designed/${d.id}`); })
      .catch((e) => setError(e.message));
  }, [id, router]);
  return <main className="flex h-screen items-center justify-center bg-[#f5f6f8] text-sm text-zinc-500">{error || 'Opening the designer…'}</main>;
}
