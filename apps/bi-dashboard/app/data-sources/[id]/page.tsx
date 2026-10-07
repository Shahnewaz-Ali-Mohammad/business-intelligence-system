'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Database, RefreshCw, Check, MessageSquare, Plug } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';

type Table = { key: string; name: string; restricted: boolean; approvedColumnCount: number; columns: { name: string; isPrimaryKey: boolean }[] };
type Relationship = { id: string; from: string; to: string; evidence: string; columns: { from: string; to: string }[] };
type Discovery = { schemas: string[]; availableSchemas?: string[]; tables: Table[]; candidates: Relationship[]; joins: Relationship[]; fingerprint: string };

export default function DataSourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [connectionString, setConnectionString] = useState('');
  const [useExisting, setUseExisting] = useState(true);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [joins, setJoins] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [ready, setReady] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${id}/warehouse`).then(async (res) => {
      if (!res.ok) throw new Error('Could not load warehouse setup.');
      return res.json();
    }).then((data) => {
      if (cancelled) return;
      setReady(data.ready); setDiscovery(data.discovery); setUseExisting(data.usesExistingWarehouse === true);
      setSchemas(data.discovery?.tables.length ? data.discovery.schemas : []);
      setTables(data.model?.selectedTables || []); setJoins(data.model?.approvedJoins || []); setWarnings(data.model?.warnings || []);
    }).catch((e) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  async function submit(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/workspaces/${id}/warehouse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Warehouse setup failed.');
      return data;
    } catch (e) { setError(e instanceof Error ? e.message : 'Warehouse setup failed.'); return null; }
    finally { setBusy(false); }
  }
  async function discover(selectedSchemas: string[]) {
    const data = await submit({ action: 'discover', useExistingWarehouse: useExisting, ...(connectionString ? { connectionString } : {}), schemas: selectedSchemas });
    if (!data) return;
    setDiscovery(data.discovery); setConnectionString('');
    setSchemas(data.discovery.tables.length ? data.discovery.schemas : []);
    setTables([]); setJoins([]);
    if (data.discovery.tables.length) {
      setTables(data.discovery.tables.filter((t: Table) => !t.restricted && t.approvedColumnCount > 0).map((t: Table) => t.key)); setJoins([]);
    }
  }
  async function activate() {
    const data = await submit({ action: 'activate', selectedTables: tables, approvedJoins: joins, draftFingerprint: discovery?.fingerprint });
    if (data) { setReady(true); setWarnings(data.warnings || []); }
  }
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  const candidates = discovery?.candidates.filter((j) => tables.includes(j.from) && tables.includes(j.to)) || [];
  return (
    <WorkspacePage active="Data Sources" title="Warehouse Connection" subtitle={ready ? 'Active' : 'Not active'} scroll action={ready ? <Link className="flex items-center gap-2 text-sm font-medium" href={`/chat?workspace=${id}`}><MessageSquare size={16} /> Open chat</Link> : undefined}>
      <div className="mx-auto max-w-5xl space-y-8">
        {loading && <p role="status">Loading warehouse...</p>}
        {error && <p role="alert" className="border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <section className="border-b border-slate-200 pb-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold"><Database size={18} /> Connection</h2>
          <form onSubmit={(e) => { e.preventDefault(); void discover([]); }} className="space-y-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useExisting} onChange={(e) => setUseExisting(e.target.checked)} disabled={busy} /> Use existing PostgreSQL warehouse</label>
            {!useExisting && <label className="block text-sm">PostgreSQL connection URL<input type="password" autoComplete="off" value={connectionString} onChange={(e) => setConnectionString(e.target.value)} placeholder="postgresql://user:password@host:5432/database" className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2" /></label>}
            <button disabled={busy || loading} className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"><Plug size={16} />{busy ? 'Checking...' : 'Connect'}</button>
          </form>
        </section>
        {discovery && <section className="border-b border-slate-200 pb-6">
          <h2 className="mb-3 text-base font-semibold">Schemas</h2>
          <div className="flex flex-wrap gap-5">{(discovery.availableSchemas || discovery.schemas).map((schema) => <label className="flex items-center gap-2 text-sm" key={schema}><input type="checkbox" checked={schemas.includes(schema)} onChange={() => setSchemas(toggle(schemas, schema))} disabled={busy} />{schema}</label>)}</div>
          <button onClick={() => discover(schemas)} disabled={busy || !schemas.length} className="mt-4 inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50"><RefreshCw size={16} />Discover tables</button>
        </section>}
        {!!discovery?.tables.length && <>
          <section className="border-b border-slate-200 pb-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">Tables <span className="font-normal text-slate-500">{tables.length} selected</span></h2><input aria-label="Search tables" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search tables" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" /></div>
            <div className="mb-3 flex gap-4 text-sm"><button onClick={() => setTables(discovery.tables.filter((t) => !t.restricted && t.approvedColumnCount).map((t) => t.key))} disabled={busy}>Select eligible</button><button onClick={() => setTables([])} disabled={busy}>Clear</button></div>
            <div className="max-h-96 overflow-auto border-y border-slate-200 bg-white">{discovery.tables.filter((t) => t.key.toLowerCase().includes(filter.toLowerCase())).map((t) => <label key={t.key} className="flex items-center justify-between gap-4 border-b border-slate-100 px-3 py-3 text-sm"><span className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={tables.includes(t.key)} onChange={() => setTables(toggle(tables, t.key))} disabled={busy || t.restricted || !t.approvedColumnCount} /><span className="break-all">{t.key}</span></span><span className="shrink-0 text-xs text-slate-500">{t.restricted ? 'Restricted' : `${t.approvedColumnCount} fields${t.columns.some((c) => c.isPrimaryKey) ? '' : ' · No primary key'}`}</span></label>)}</div>
          </section>
          <section className="border-b border-slate-200 pb-6">
            <h2 className="mb-3 text-base font-semibold">Relationships</h2>
            <p className="mb-3 text-sm text-slate-500">{discovery.joins.filter((j) => tables.includes(j.from) && tables.includes(j.to)).length} declared relationships</p>
            <div className="max-h-80 overflow-auto divide-y divide-slate-200">{candidates.map((j) => <label key={j.id} className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1" checked={joins.includes(j.id)} onChange={() => setJoins(toggle(joins, j.id))} disabled={busy} /><span className="min-w-0 break-all">{j.from} → {j.to}<span className="mt-1 block text-xs text-slate-500">{j.columns.map((p) => `${p.from} = ${p.to}`).join(', ')} · {j.evidence}</span></span></label>)}</div>
            {!candidates.length && <p className="text-sm text-slate-500">No additional relationships proposed.</p>}
          </section>
          <button onClick={activate} disabled={busy || !tables.length || tables.length > 250} className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"><Check size={16} />{busy ? 'Validating...' : ready ? 'Validate and update' : 'Validate and activate'}</button>
        </>}
        {!!warnings.length && <ul className="space-y-2 border-l-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        {ready && <Link href={`/chat?workspace=${id}`} className="flex items-center gap-2 text-sm font-semibold text-indigo-700"><MessageSquare size={16} />Chat with this warehouse</Link>}
      </div>
    </WorkspacePage>
  );
}
