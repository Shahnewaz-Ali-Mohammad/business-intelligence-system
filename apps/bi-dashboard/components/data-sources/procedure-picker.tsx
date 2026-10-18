'use client';
import { useEffect, useRef, useState } from 'react';
import { Play, X, Search, Check, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkspaceAnswer } from './workspace-result';

type Parameter = { name: string; type: string; baseType?: string; output?: boolean; hasDefault?: boolean; tableType?: string; nullable?: boolean; tableColumns?: Parameter[] };
type Procedure = { id: number; schema: string; name: string; definition: string; hash: string; allowed: boolean; reason: string; approved: boolean; requiresWriteConsent?: boolean; parameters: Parameter[] };
type ParameterMode = 'value' | 'null' | 'default' | 'output';

function ScalarInput({ parameter, value, onChange, disabled, id }: { parameter: Parameter; value: unknown; onChange: (value: string) => void; disabled: boolean; id: string }) {
  const type = parameter.baseType || parameter.type;
  const className = 'h-10 w-full min-w-0 rounded-md border bg-white px-2 text-sm disabled:bg-zinc-50';
  if (type === 'bit') return <select id={id} required disabled={disabled} value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={className}><option value="">Select</option><option value="1">Yes</option><option value="0">No</option></select>;
  return <input id={id} required={!/char|text|xml/.test(type)} disabled={disabled} type={type === 'date' ? 'date' : type === 'time' ? 'time' : /^(datetime|datetime2|smalldatetime)$/.test(type) ? 'datetime-local' : 'text'} step="any" inputMode={/int|decimal|numeric|money|float|real/.test(type) ? 'decimal' : undefined} value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={className}/>;
}

function TableInput({ parameter, rows, onChange, disabled }: { parameter: Parameter; rows: Record<string, unknown>[]; onChange: (rows: Record<string, unknown>[]) => void; disabled: boolean }) {
  const columns = parameter.tableColumns || [];
  return <div className="space-y-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{columns.map(column => <th className="min-w-36 p-1" key={column.name}>{column.name} <span className="font-normal text-zinc-500">{column.type}</span></th>)}<th/></tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td className="p-1" key={column.name}><ScalarInput id={`tvp-${parameter.name}-${index}-${column.name}`} parameter={column} value={row[column.name]} disabled={disabled || row[column.name] === null} onChange={value => onChange(rows.map((r, i) => i === index ? { ...r, [column.name]: value } : r))}/>{column.nullable && <label className="flex items-center gap-1"><input type="checkbox" disabled={disabled} checked={row[column.name] === null} onChange={e => onChange(rows.map((r, i) => i === index ? { ...r, [column.name]: e.target.checked ? null : '' } : r))}/>NULL</label>}</td>)}<td><button type="button" title="Remove input row" aria-label={`Remove input row ${index + 1}`} disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={16}/></button></td></tr>)}</tbody></table><Button type="button" size="sm" variant="outline" disabled={disabled || rows.length >= 10000} onClick={() => onChange([...rows, Object.fromEntries(columns.map(c => [c.name, c.nullable ? null : '']))])}><Plus size={14}/>Add row</Button></div>;
}
export function ProcedurePicker({ workspaceId, sourceId, search, sessionId, onClose, onResult }: { workspaceId: string; sourceId: string; search: string; sessionId: number | null; onClose: () => void; onResult: (answer: WorkspaceAnswer) => void }) {
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [selected, setSelected] = useState<Procedure | null>(null);
  const [filter, setFilter] = useState(search.replace(/^\//, ''));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [modes, setModes] = useState<Record<string, ParameterMode>>({});
  const [allowBusinessWrites, setAllowBusinessWrites] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const endpoint = `/api/workspaces/${workspaceId}/procedures`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${endpoint}?sourceId=${encodeURIComponent(sourceId)}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setProcedures(body.procedures);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [endpoint, sourceId]);
  async function choose(procedure: Procedure) {
    setBusy(true); setError(''); setReviewed(false); setAllowBusinessWrites(false);
    try {
      const response = await fetch(`${endpoint}?sourceId=${encodeURIComponent(sourceId)}&procedureId=${procedure.id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      const current: Procedure = body.procedures[0];
      if (!current) throw new Error('Procedure unavailable.');
      setSelected(current);
      setModes(Object.fromEntries(current.parameters.map(p => [p.name, p.output ? 'output' : p.hasDefault && !p.tableType ? 'default' : 'value'])));
      setValues(Object.fromEntries(current.parameters.map(p => [p.name, p.tableType ? [] : ''])));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load parameters.'); } finally { setBusy(false); }
  }
  async function submit(action: 'approve' | 'run') {
    if (!selected) return;
    setBusy(true); setError('');
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const inputValues = Object.fromEntries(selected.parameters.filter(p => !['default', 'output'].includes(modes[p.name])).map(p => [p.name, modes[p.name] === 'null' ? null : values[p.name]]));
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, sourceId, procedureId: selected.id, values: inputValues, omitted: selected.parameters.filter(p => modes[p.name] === 'default').map(p => p.name), hash: selected.hash, reviewed, sessionId, allowBusinessWrites }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (action === 'approve') { setSelected({ ...selected, approved: true }); }
      else onResult(body);
    } catch (e) { setError(controller.signal.aborted ? 'Report cancelled. If a write-capable procedure had already started, cancellation does not undo committed database changes.' : e instanceof Error ? e.message : 'Report failed.'); } finally { setBusy(false); abortRef.current = null; }
  }
  return <section aria-label="Stored procedure reports" className="mx-3 mb-3 max-h-[60vh] shrink-0 overflow-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{selected ? `${selected.schema}.${selected.name}` : 'Stored procedure reports'}</h3><button type="button" aria-label="Close report picker" title="Close" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
    {!selected ? <><label className="mb-2 flex items-center gap-2 rounded-md border p-2"><Search size={16}/><input autoFocus aria-label="Search stored procedures" value={filter} onChange={e => setFilter(e.target.value)} className="min-w-0 flex-1 text-sm outline-none"/></label>
      {pending ? <p role="status" className="text-sm text-zinc-500">Loading procedures…</p> : <div className="max-h-56 overflow-auto">{procedures.filter(p => `${p.schema}.${p.name}`.toLowerCase().includes(filter.toLowerCase())).map(p => <button type="button" disabled={busy} key={p.id} onClick={() => void choose(p)} className="block w-full break-all rounded-md px-3 py-2 text-left text-sm hover:bg-rose-50">{p.schema}.{p.name}</button>)}{!procedures.length && !error && <p className="text-sm text-zinc-500">No executable procedures were found for this database account.</p>}</div>}</> : <>
      {!selected.allowed && <p className="mb-3 text-sm text-amber-800">{selected.reason}</p>}
      {selected.allowed && selected.requiresWriteConsent && <p className="mb-3 text-sm text-amber-800">{selected.reason}</p>}
      {!selected.approved && selected.allowed && <div className="mb-3 space-y-2"><details><summary className="cursor-pointer text-sm">Review procedure SQL</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all bg-zinc-50 p-3 text-xs">{selected.definition}</pre></details><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>I reviewed this procedure and approve it for reporting.</label><Button type="button" size="sm" disabled={!reviewed || busy} onClick={() => void submit('approve')}><Check size={14}/>Approve report procedure</Button></div>}
      <form onSubmit={e => { e.preventDefault(); void submit('run'); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{selected.parameters.map(p => <div key={p.name} className={`min-w-0 ${p.tableType ? 'sm:col-span-2' : ''}`}><label className="mb-1 block break-all text-sm" htmlFor={`procedure-${p.name}`}>{p.name.replace(/^@/, '')} <span className="text-xs text-zinc-400">{p.type}{p.output ? ' · input/output' : ''}</span></label>
          {p.tableType ? <TableInput parameter={p} rows={(values[p.name] || []) as Record<string, unknown>[]} disabled={busy} onChange={rows => setValues(v => ({ ...v, [p.name]: rows }))}/> : <>
            <select aria-label={`${p.name} value mode`} disabled={busy} value={modes[p.name] || 'value'} onChange={e => setModes(m => ({ ...m, [p.name]: e.target.value as ParameterMode }))} className="mb-2 h-9 w-full rounded-md border bg-white px-2 text-sm"><option value="value">Enter value{p.output ? ' and capture output' : ''}</option><option value="null">NULL{p.output ? ' and capture output' : ''}</option>{!p.output && <option value="default">Procedure default{p.hasDefault ? '' : ' (SQL Server validates)'}</option>}{p.output && <option value="output">Capture output only</option>}</select>
            {(!modes[p.name] || modes[p.name] === 'value') && <ScalarInput id={`procedure-${p.name}`} parameter={p} value={values[p.name]} disabled={busy} onChange={value => setValues(v => ({ ...v, [p.name]: value }))}/>}
          </>}
        </div>)}</div>
        {selected.requiresWriteConsent && <label className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><input type="checkbox" checked={allowBusinessWrites} disabled={busy} onChange={e => setAllowBusinessWrites(e.target.checked)}/>This procedure may change business records or execute other procedures. I authorize those changes for this run.</label>}
        <div className="mt-4 flex flex-wrap gap-2"><Button type="submit" disabled={busy || !selected.approved || !selected.allowed || (selected.requiresWriteConsent && !allowBusinessWrites)}><Play size={14}/>{busy ? 'Running…' : 'Generate Report'}</Button>{busy && <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>Cancel run</Button>}<Button type="button" variant="outline" disabled={busy} onClick={() => setSelected(null)}>Back</Button></div>
      </form>
    </>}
  </section>;
}
