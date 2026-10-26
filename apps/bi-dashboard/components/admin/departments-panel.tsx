'use client';

import { useCallback, useEffect, useState } from 'react';
import { inputClass, buttonClass, ghostClass, post } from './admin-ui';

type Department = { id: number; name: string; parentId: number | null; members: number };

/** The department tree. A Manager of a department also covers everything under it. */
export function DepartmentsPanel() {
  const [list, setList] = useState<Department[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string; parentId: number | null } | null>(null);

  const load = useCallback(() => fetch('/api/admin/departments').then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setList(d.departments); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);
  async function run(body: unknown, done?: () => void) {
    setBusy(true); setError('');
    try { await post('/api/admin/departments', body); done?.(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  if (!list) return <p className="text-sm text-zinc-500">{error || 'Loading...'}</p>;

  // Tree order: each department followed by the ones under it, indented.
  const ordered: { d: Department; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => list.filter((d) => d.parentId === parent).forEach((d) => { ordered.push({ d, depth }); if (depth < 20) walk(d.id, depth + 1); });
  walk(null, 0);
  const parentOptions = (exclude?: number) => list.filter((d) => d.id !== exclude);

  return (
    <div className="space-y-5">
      <form className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 bg-white p-4" onSubmit={(e) => { e.preventDefault(); void run({ action: 'create', name, parentId }, () => setName('')); }}>
        <label className="flex flex-col gap-1 text-sm">New department<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="e.g. Billing" /></label>
        <label className="flex flex-col gap-1 text-sm">Under
          <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)} className={inputClass}>
            <option value="">Top level</option>
            {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button className={buttonClass} disabled={busy}>Add</button>
      </form>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {ordered.length === 0 ? <p className="text-sm text-zinc-500">No departments yet.</p> : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white text-sm">
          {ordered.map(({ d, depth }) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ paddingLeft: 12 + depth * 20 }}>
              {editing?.id === d.id ? (
                <>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={inputClass} />
                  <select value={editing.parentId ?? ''} onChange={(e) => setEditing({ ...editing, parentId: e.target.value ? Number(e.target.value) : null })} className={inputClass}>
                    <option value="">Top level</option>
                    {parentOptions(d.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button className={ghostClass} disabled={busy} onClick={() => void run({ action: 'update', ...editing }, () => setEditing(null))}>Save</button>
                  <button className={ghostClass} onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1 font-medium text-zinc-800">{depth > 0 ? '↳ ' : ''}{d.name}</span>
                  <span className="text-xs text-zinc-500">{d.members} {d.members === 1 ? 'person' : 'people'}</span>
                  <button className={ghostClass} disabled={busy} onClick={() => setEditing({ id: d.id, name: d.name, parentId: d.parentId })}>Edit</button>
                  <button className={ghostClass} disabled={busy} onClick={() => { if (window.confirm(`Delete ${d.name}?`)) void run({ action: 'delete', id: d.id }); }}>Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
