'use client';

import { useCallback, useEffect, useState } from 'react';
import { buttonClass, post } from './admin-ui';

type Workspace = { id: string; name: string; departmentIds: number[] };
type Department = { id: number; name: string; parentId: number | null };

/**
 * Which departments may open each workspace. People see only their
 * departments' workspaces (Managers also those of departments below theirs);
 * the CEO and admins see all. A workspace with no department is CEO/admin only.
 */
export function WorkspacesPanel() {
  const [data, setData] = useState<{ workspaces: Workspace[]; departments: Department[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, number[]>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => fetch('/api/admin/workspaces').then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); setDraft(Object.fromEntries(d.workspaces.map((w: Workspace) => [w.id, w.departmentIds]))); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  async function save(workspaceId: string) {
    setBusy(workspaceId); setError(''); setSaved('');
    try { await post('/api/admin/workspaces', { workspaceId, departmentIds: draft[workspaceId] || [] }, 'PUT'); setSaved(workspaceId); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(''); }
  }
  if (!data) return <p className="text-sm text-zinc-600">{error || 'Loading...'}</p>;
  const toggle = (ws: string, id: number) => setDraft((d) => ({ ...d, [ws]: (d[ws] || []).includes(id) ? (d[ws] || []).filter((x) => x !== id) : [...(d[ws] || []), id] }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">Tick the departments that may open each workspace. The CEO and admins open every workspace; a workspace with no department is CEO and admin only.</p>
      {!data.departments.length && <p className="text-sm text-amber-700">Create departments first (Departments tab).</p>}
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {data.workspaces.map((w) => {
          const changed = JSON.stringify([...(draft[w.id] || [])].sort()) !== JSON.stringify([...w.departmentIds].sort());
          return (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-48 flex-1 font-medium text-zinc-800">{w.name}{!w.departmentIds.length && <span className="ml-2 text-xs font-normal text-zinc-500">CEO and admins only</span>}</span>
              <div className="flex flex-wrap gap-3">
                {data.departments.map((d) => (
                  <label key={d.id} className="flex items-center gap-1.5 text-sm text-zinc-700">
                    <input type="checkbox" checked={(draft[w.id] || []).includes(d.id)} onChange={() => toggle(w.id, d.id)} />{d.name}
                  </label>
                ))}
              </div>
              <button className={buttonClass} disabled={!changed || busy === w.id} onClick={() => void save(w.id)}>{busy === w.id ? 'Saving...' : 'Save'}</button>
              {saved === w.id && !changed && <span className="text-xs text-emerald-700">Saved</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
