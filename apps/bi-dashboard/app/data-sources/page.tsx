'use client';
import { RequirePermission } from '@/components/auth/require-permission';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WorkspacePage } from '@/components/workspace/workspace-page';

interface DataSourceRow {
  id: string;
  name: string;
  createdAt: string;
}

function DataSourcesPageContent() {
  const router = useRouter();
  const [rows, setRows] = useState<DataSourceRow[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not load workspaces.');
        if (!cancelled) setRows(data.workspaces || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load workspaces.');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function deleteDataSource(id: string) {
    if (!window.confirm('Remove this workspace? Its saved connections, semantic model, tools, and test history will be deleted too. Source databases will not be changed. This cannot be undone.')) {
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
    window.dispatchEvent(new Event('bi:workspaces-changed'));
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
    window.dispatchEvent(new Event('bi:workspaces-changed'));
    setName('');
    router.push(`/data-sources/${data.workspace.id}/tools`);
  }

  return (
    <WorkspacePage
      active="Settings"
      title="Settings"
      subtitle="Database connections and workspaces"
      scroll
    >
      <section className="rounded-lg border border-zinc-200/80 bg-white p-5 shadow-sm">
        <form onSubmit={createDataSource} className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this workspace (e.g. Ticketing & Billing)"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create workspace'}
          </button>
        </form>
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}{error === 'Sign in required.' && <Link href="/login" className="ml-3 underline">Sign in</Link>}</p>}

        <ul className="mt-6 divide-y divide-zinc-100">
          {loading && <li className="py-3 text-sm text-zinc-500">Loading...</li>}
          {!loading && !error && rows.length === 0 && (
            <li className="py-3 text-sm text-zinc-500">No additional data sources yet -- add one above.</li>
          )}
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <Link href={row.id === 'isp-default' ? '/chat?original=1' : `/data-sources/${row.id}/tools`} className="min-w-0 flex-1 break-words text-sm font-medium text-zinc-800 hover:underline">
                {row.name}
              </Link>
              <div className="flex items-center gap-4">
                {row.id !== 'isp-default' && <Link href={`/data-sources/${row.id}/chat`} className="text-xs font-medium text-rose-700 hover:underline">Workspace chat</Link>}
                <Link href={row.id === 'isp-default' ? '/chat?original=1' : `/data-sources/${row.id}/tools`} className="text-xs text-rose-800 hover:text-rose-900">
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

/** Workspace setup is admin work. */
export default function DataSourcesPage() {
  return <RequirePermission permission="setup.manage" message="Workspace setup is for admins."><DataSourcesPageContent /></RequirePermission>;
}
