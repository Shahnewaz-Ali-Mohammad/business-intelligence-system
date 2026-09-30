'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { WorkspacePage } from '@/components/workspace/workspace-page';

type Step = 'connection' | 'sync' | 'draft' | 'confirm' | 'done';

export default function DataSourceDetailPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;

  const [host, setHost] = useState('');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [step, setStep] = useState<Step>('connection');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [introspectionSummary, setIntrospectionSummary] = useState<string | null>(null);
  const [confirmedYaml, setConfirmedYaml] = useState('');

  async function saveConnection(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dialect: 'postgres', host, port, database, connectionString }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMessage(`Error: ${JSON.stringify(data.error)}`);
      return;
    }
    if (data.introspectionError) {
      setMessage(`Connection saved, but introspection failed: ${data.introspectionError}. Fix and try Draft again.`);
    } else {
      const tableCount = data.introspection?.tables?.length ?? 0;
      setIntrospectionSummary(`Found ${tableCount} table${tableCount === 1 ? '' : 's'}.`);
      setMessage('Connection saved and schema read successfully.');
    }
    setStep('sync');
  }

  async function runSync() {
    setBusy(true);
    setMessage("Syncing tables into this workspace's own warehouse copy (dlt) -- this can take a while for large tables...");
    const res = await fetch(`/api/workspaces/${workspaceId}/sync`, { method: 'POST' });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMessage(`Sync failed: ${data.error}`);
      return;
    }
    setMessage('Sync complete.');
    setStep('draft');
  }

  async function runDraft() {
    setBusy(true);
    setMessage('Reading the schema and asking the model to propose measures/dimensions...');
    const res = await fetch(`/api/workspaces/${workspaceId}/draft-model`, { method: 'POST' });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMessage(`Draft failed: ${data.error}`);
      return;
    }
    setConfirmedYaml(data.yaml || '');
    setMessage('Draft ready -- review and edit below before confirming.');
    setStep('confirm');
  }

  async function confirmModel() {
    setBusy(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/confirm-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedYaml }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMessage(`Confirm failed: ${data.error}`);
      return;
    }
    setMessage('Semantic model confirmed for this data source.');
    setStep('done');
  }

  return (
    <WorkspacePage active="Data Sources" title="Set up this data source" subtitle="Connect, review the schema, then confirm the AI-drafted model before it's used.">
      <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
        <ol className="flex gap-2 text-xs">
          {(['connection', 'sync', 'draft', 'confirm', 'done'] as Step[]).map((s) => (
            <li key={s} className={`rounded-full px-3 py-1 ${step === s ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
              {s}
            </li>
          ))}
        </ol>

        {message && <p className="mt-4 text-sm text-slate-700">{message}</p>}
        {introspectionSummary && <p className="mt-1 text-xs text-slate-500">{introspectionSummary}</p>}

        {step === 'connection' && (
          <form onSubmit={saveConnection} className="mt-6 space-y-3">
            <p className="text-xs text-slate-500">Postgres only for now &mdash; MySQL/SQL Server/Oracle support is the next increment.</p>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host" className="w-full rounded-md border px-3 py-2 text-sm" required />
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" className="w-full rounded-md border px-3 py-2 text-sm" required />
            <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="Database name" className="w-full rounded-md border px-3 py-2 text-sm" required />
            <textarea
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder="Full connection string (encrypted at rest, never shown again)"
              className="w-full rounded-md border px-3 py-2 text-sm"
              rows={2}
              required
            />
            <button type="submit" disabled={busy} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? 'Saving...' : 'Save connection'}
            </button>
          </form>
        )}

        {step === 'sync' && (
          <button onClick={runSync} disabled={busy} className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'Syncing...' : 'Sync now'}
          </button>
        )}

        {step === 'draft' && (
          <button onClick={runDraft} disabled={busy} className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'Drafting...' : 'Draft semantic model'}
          </button>
        )}

        {step === 'confirm' && (
          <div className="mt-6 space-y-3">
            <p className="text-xs text-slate-500">Edit anything below before confirming &mdash; this exact text becomes the live model.</p>
            <textarea
              value={confirmedYaml}
              onChange={(e) => setConfirmedYaml(e.target.value)}
              className="w-full rounded-md border px-3 py-2 font-mono text-xs"
              rows={20}
            />
            <button onClick={confirmModel} disabled={busy} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? 'Confirming...' : 'Confirm and go live'}
            </button>
          </div>
        )}

        {step === 'done' && <p className="mt-6 text-sm text-emerald-700">This data source&apos;s semantic model is confirmed.</p>}
      </section>
    </WorkspacePage>
  );
}
