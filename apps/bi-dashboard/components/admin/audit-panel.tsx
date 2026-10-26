'use client';

import { useCallback, useEffect, useState } from 'react';
import { inputClass, ghostClass } from './admin-ui';

type Entry = { id: number; action: string; target: string | null; details: unknown; at: string; user: string | null };

/** Who did what: sign-ins, questions, exports, schedules and access changes. */
export function AuditPanel() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');

  const load = useCallback((p: number) => {
    const q = new URLSearchParams({ page: String(p), ...(user ? { user } : {}), ...(action ? { action } : {}) });
    return fetch(`/api/admin/audit?${q}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setEntries(d.entries); setHasMore(d.hasMore); setPage(p); }).catch((e) => setError(e.message));
  }, [user, action]);
  useEffect(() => { void load(1); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input placeholder="Filter by email" value={user} onChange={(e) => setUser(e.target.value)} className={inputClass} />
        <select value={action} onChange={(e) => setAction(e.target.value)} className={inputClass}>
          <option value="">All actions</option>
          {['login', 'question', 'export', 'procedure', 'schedule', 'user', 'department', 'data_access', 'workspace'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!entries ? <p className="text-sm text-zinc-500">Loading...</p> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 text-zinc-500"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Target</th><th className="px-3 py-2">Details</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-zinc-100 align-top">
                  <td className="whitespace-nowrap px-3 py-1.5">{new Date(e.at).toLocaleString()}</td>
                  <td className="px-3 py-1.5">{e.user || 'System'}</td>
                  <td className="px-3 py-1.5 font-medium">{e.action}</td>
                  <td className="max-w-[16rem] truncate px-3 py-1.5" title={e.target || ''}>{e.target}</td>
                  <td className="max-w-[24rem] truncate px-3 py-1.5 text-zinc-500" title={e.details ? JSON.stringify(e.details) : ''}>{e.details ? JSON.stringify(e.details) : ''}</td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-zinc-500">No entries.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <button className={ghostClass} disabled={page <= 1} onClick={() => void load(page - 1)}>Newer</button>
        <button className={ghostClass} disabled={!hasMore} onClick={() => void load(page + 1)}>Older</button>
      </div>
    </div>
  );
}
