'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkspacePage } from '@/components/workspace/workspace-page';

interface DataSourceRow {
  id: string;
  name: string;
  createdAt: string;
}

export default function DataSourcesPage() {
  const [rows, setRows] = useState<DataSourceRow[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/workspaces');
      const data = await res.json();
      if (!cancelled) {
        setRows(data.workspaces || []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function deleteDataSource(id: string) {
    if (!window.confirm('Remove this data source? Its saved connection and semantic model will be deleted too. This cannot be undone.')) {
      return;
    }
    setDeletingId(id);
    setError(null);
    const res = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    setDeletingId(null);
    if (!res.ok) {
      setError(data.error || 'Failed to delete.');
      return;
    }
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  async function createDataSource(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(data.error ? JSON.stringify(data.error) : 'Failed to create.');
      return;
    }
    setRows((prev) => [data.workspace, ...prev]);
    setName('');
  }

  return (
    <WorkspacePage
      active="Data Sources"
      title="Data Sources"
      subtitle="Connect another database alongside the ISP system -- each one gets its own synced copy and its own semantic model, reviewed before it goes live."
    >
      <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
        <form onSubmit={createDataSource} className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this data source (e.g. Acme Retail Postgres)"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Add data source'}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <ul className="mt-6 divide-y divide-slate-100">
          {loading && <li className="py-3 text-sm text-slate-500">Loading...</li>}
          {!loading && rows.length === 0 && (
            <li className="py-3 text-sm text-slate-500">No additional data sources yet -- add one above.</li>
          )}
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between py-3">
              <Link href={`/data-sources/${row.id}`} className="text-sm font-medium text-slate-900 hover:underline">
                {row.name}
              </Link>
              <div className="flex items-center gap-4">
                <Link href={`/data-sources/${row.id}`} className="text-xs text-slate-500 hover:text-slate-900">
                  Open &rarr;
                </Link>
                {row.id !== 'isp-default' && (
                  <button
                    type="button"
                    onClick={() => deleteDataSource(row.id)}
                    disabled={deletingId === row.id}
                    className="text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    {deletingId === row.id ? 'Removing...' : 'Delete'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}
