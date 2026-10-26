'use client';

import { useEffect, useMemo, useState } from 'react';
import { inputClass, buttonClass, ghostClass, post } from './admin-ui';

type Source = { id: string; database: string; workspace: string; configured: boolean };
type Table = { id: string; name: string; kind: string; columns: { name: string; dataType: string }[] };
type Procedure = { id: string; name: string; parameters: string[] };
type Department = { id: number; name: string; parentId: number | null };
type Policy = { departmentField?: string; departmentValues: Record<string, string[]>; tables: Record<string, 'department' | 'shared' | 'restricted'>; procedures: Record<string, { parameter: string }> };
type Detail = { tables: Table[]; procedures: Procedure[]; policy: Policy; departments: Department[] };

const CLASSES = [
  { value: 'department', label: 'Department', hint: 'filtered to each person’s department' },
  { value: 'shared', label: 'Shared', hint: 'everyone sees all rows (lists, statuses)' },
  { value: 'restricted', label: 'CEO only', hint: 'hidden from Managers and Executives' },
] as const;

/**
 * Per database: which column says which department a record belongs to,
 * which stored values belong to each department, and how each table and
 * stored procedure is treated. Tables left unset are hidden from Managers
 * and Executives. The CEO always sees everything.
 */
export function DataAccessPanel() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [values, setValues] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetch('/api/admin/data-access').then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setSources(d.sources); }).catch((e) => setError(e.message)); }, []);
  function choose(id: string) {
    setSourceId(id); setDetail(null); setPolicy(null); setValues(null); setError(''); setNotice('');
    if (!id) return;
    fetch(`/api/admin/data-access?sourceId=${encodeURIComponent(id)}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setDetail(d); setPolicy({ departmentValues: {}, tables: {}, procedures: {}, ...d.policy }); if (d.policy?.departmentField) loadValues(d.policy.departmentField, id); }).catch((e) => setError(e.message));
  }
  function loadValues(field: string, id = sourceId) {
    setValues(null); if (!field) return;
    fetch(`/api/admin/data-access?sourceId=${encodeURIComponent(id)}&field=${encodeURIComponent(field)}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setValues(d.values); }).catch((e) => setError(e.message));
  }

  const tables = useMemo(() => (detail?.tables || []).filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase())), [detail, filter]);
  if (!sources) return <p className="text-sm text-zinc-500">{error || 'Loading...'}</p>;
  const set = (next: Partial<Policy>) => policy && setPolicy({ ...policy, ...next });

  async function save() {
    if (!policy) return;
    setBusy(true); setError(''); setNotice('');
    try { await post('/api/admin/data-access', { sourceId, policy }, 'PUT'); setNotice('Saved. The rules apply from the next question.'); setSources((s) => s?.map((x) => (x.id === sourceId ? { ...x, configured: true } : x)) || s); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <label className="flex max-w-xl flex-col gap-1 text-sm">Database
        <select value={sourceId} onChange={(e) => choose(e.target.value)} className={inputClass}>
          <option value="">Choose a database</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.workspace} · {s.database}{s.configured ? '' : ' (not set up)'}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {sourceId && (!detail || !policy) && !error && <p className="text-sm text-zinc-500">Loading...</p>}
      {detail && policy && (
        <>
          <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-zinc-800">1. Department column</h2>
            <p className="text-xs text-zinc-500">The column that says which department a record belongs to (for example a zone, branch or department id). Department tables must be able to reach it.</p>
            <select value={policy.departmentField || ''} onChange={(e) => { set({ departmentField: e.target.value || undefined }); setValues(null); loadValues(e.target.value); }} className={`${inputClass} w-full max-w-xl`}>
              <option value="">Choose a column</option>
              {detail.tables.map((t) => <optgroup key={t.id} label={t.name}>{t.columns.map((c) => <option key={c.name} value={`${t.id}:${c.name}`}>{t.name}.{c.name} ({c.dataType})</option>)}</optgroup>)}
            </select>
          </section>

          {policy.departmentField && (
            <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-800">2. Which values belong to each department</h2>
              {!detail.departments.length ? <p className="text-xs text-amber-700">Create departments first (Departments tab).</p> : values === null ? <p className="text-xs text-zinc-500">Reading the values stored in this column...</p> : (
                detail.departments.map((d) => {
                  const chosen = policy.departmentValues[String(d.id)] || [];
                  return (
                    <div key={d.id}>
                      <p className="mb-1 text-xs font-semibold text-zinc-700">{d.name} <span className="font-normal text-zinc-500">({chosen.length} selected)</span></p>
                      <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                        {values.map((v) => {
                          const on = chosen.includes(v);
                          return <button key={v} type="button" onClick={() => set({ departmentValues: { ...policy.departmentValues, [d.id]: on ? chosen.filter((x) => x !== v) : [...chosen, v] } })}
                            className={`rounded border px-1.5 py-0.5 text-xs ${on ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'}`}>{v}</button>;
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          )}

          <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-800">3. Tables</h2>
              <input placeholder="Search tables" value={filter} onChange={(e) => setFilter(e.target.value)} className={inputClass} />
            </div>
            <p className="text-xs text-zinc-500">{CLASSES.map((c) => `${c.label}: ${c.hint}`).join(' · ')}. Tables left unset are hidden from Managers and Executives.</p>
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <tbody>
                  {tables.map((t) => (
                    <tr key={t.id} className="border-t border-zinc-100">
                      <td className="py-1.5 pr-3">{t.name}{t.kind === 'view' ? <span className="ml-1 text-xs text-zinc-400">view</span> : null}</td>
                      <td className="py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {CLASSES.map((c) => (
                            <button key={c.value} type="button" onClick={() => set({ tables: { ...policy.tables, [t.id]: c.value } })}
                              className={`rounded border px-2 py-0.5 text-xs ${policy.tables[t.id] === c.value ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'}`}>{c.label}</button>
                          ))}
                          {policy.tables[t.id] && <button type="button" className={ghostClass} onClick={() => { const next = { ...policy.tables }; delete next[t.id]; set({ tables: next }); }}>Unset</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {detail.procedures.length > 0 && (
            <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-800">4. Stored procedures</h2>
              <p className="text-xs text-zinc-500">A procedure’s results cannot be filtered afterwards. Choose the parameter that takes the department value; the server fills it in for each person and they cannot change it. Otherwise only the CEO can run it.</p>
              {detail.procedures.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-56 flex-1">{p.name}</span>
                  <select value={policy.procedures[p.id]?.parameter || ''} onChange={(e) => { const next = { ...policy.procedures }; if (e.target.value) next[p.id] = { parameter: e.target.value }; else delete next[p.id]; set({ procedures: next }); }} className={inputClass}>
                    <option value="">CEO only</option>
                    {p.parameters.map((name) => <option key={name} value={name}>Department parameter: {name}</option>)}
                  </select>
                </div>
              ))}
            </section>
          )}

          <ViewAs sourceId={sourceId} tables={detail.tables} />

          <div className="flex items-center gap-3">
            <button className={buttonClass} disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save rules'}</button>
            {notice && <span className="text-sm text-emerald-700">{notice}</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** "View as": checks what one person would get from one table under the SAVED rules. */
function ViewAs({ sourceId, tables }: { sourceId: string; tables: Table[] }) {
  const [people, setPeople] = useState<{ id: number; email: string }[]>([]);
  const [person, setPerson] = useState('');
  const [table, setTable] = useState('');
  const [result, setResult] = useState<{ outcome: string; message: string; departments?: string[] } | null>(null);
  useEffect(() => { fetch('/api/admin/users').then((r) => r.json()).then((d) => setPeople(d.users || [])).catch(() => {}); }, []);
  function check(nextPerson: string, nextTable: string) {
    setResult(null);
    if (!nextPerson || !nextTable) return;
    fetch(`/api/admin/data-access?sourceId=${encodeURIComponent(sourceId)}&previewUser=${nextPerson}&table=${encodeURIComponent(nextTable)}`).then((r) => r.json()).then(setResult).catch(() => setResult({ outcome: 'blocked', message: 'Could not check.' }));
  }
  return (
    <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-800">View as</h2>
      <p className="text-xs text-zinc-500">Check what a person would see from a table, using the saved rules (save first).</p>
      <div className="flex flex-wrap gap-2">
        <select value={person} onChange={(e) => { setPerson(e.target.value); check(e.target.value, table); }} className={inputClass}>
          <option value="">Choose a person</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.email}</option>)}
        </select>
        <select value={table} onChange={(e) => { setTable(e.target.value); check(person, e.target.value); }} className={inputClass}>
          <option value="">Choose a table</option>
          {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      {result && (
        <p className={`rounded-md border p-2 text-sm ${result.outcome === 'blocked' ? 'border-red-200 bg-red-50 text-red-800' : result.outcome === 'filtered' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          {result.outcome === 'blocked' ? 'Blocked: ' : result.outcome === 'filtered' ? 'Filtered: ' : 'All rows: '}{result.message}
          {result.departments?.length ? <span className="block text-xs opacity-80">Departments covered: {result.departments.join(', ')}</span> : null}
        </p>
      )}
    </section>
  );
}
