'use client';
import { useEffect, useRef, useState } from 'react';
import { Play, X, Search, Plus, Trash2 } from 'lucide-react';
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
type Fill = { matched: boolean; message?: string; procedureId?: number; values?: Record<string, unknown>; modes?: Record<string, ParameterMode>; filled?: string[]; missing?: string[]; ready?: boolean };

/**
 * `fill`: what the person typed in the chat box. With no report chosen yet it
 * picks the report and fills its form; with a report chosen it fills that
 * report's form. When every value is there, the report runs straight away.
 */
export function ProcedurePicker({ workspaceId, sourceId, search, sessionId, fill: typed, onClose, onResult }: { workspaceId: string; sourceId: string; search: string; sessionId: number | null; fill?: { text: string; key: number }; onClose: () => void; onResult: (answer: WorkspaceAnswer) => void }) {
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [selected, setSelected] = useState<Procedure | null>(null);
  const [filter, setFilter] = useState(search.replace(/^\//, ''));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [modes, setModes] = useState<Record<string, ParameterMode>>({});
  const [allowBusinessWrites, setAllowBusinessWrites] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [fillNote, setFillNote] = useState('');
  // A sentence typed into the search box and sent with Enter fills the form too.
  const [typedFill, setTypedFill] = useState<{ text: string; key: number } | null>(null);
  const request = typedFill && (!typed || typedFill.key > typed.key) ? typedFill : typed;
  const selectedRef = useRef<Procedure | null>(null);
  selectedRef.current = selected;
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
  // Reads the typed sentence, picks the report and fills its form. Nothing runs until Generate Report.
  useEffect(() => {
    if (!request?.text) return;
    const current = selectedRef.current;
    const controller = new AbortController();
    Promise.resolve().then(() => { setBusy(true); setFillNote('Filling the report form from your message…'); })
      .then(() => fetch(`${endpoint}/fill`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId, text: request.text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(current ? { procedureId: current.id } : {}) }) }))
      .then(async (response) => { const body = await response.json() as Fill & { error?: string }; if (!response.ok) throw new Error(body.error); return body; })
      .then(async (fill) => {
        if (controller.signal.aborted) return;
        if (!fill.matched || !fill.procedureId) { setFillNote(fill.message || 'No report matched. Pick one from the list.'); setBusy(false); return; }
        const loaded = await choose({ id: fill.procedureId } as Procedure, fill);
        const filled = (fill.filled || []).map((n) => n.replace(/^@/, ''));
        const missing = (fill.missing || []).map((n) => n.replace(/^@/, ''));
        if (fill.ready && loaded) {
          // Everything is there: run it and answer in the chat.
          setFillNote(`Running with ${filled.length ? filled.join(', ') : 'the procedure defaults'}…`);
          await submit(loaded, fill.values || {}, { ...Object.fromEntries(loaded.parameters.map(p => [p.name, p.output ? 'output' : p.hasDefault && !p.tableType ? 'default' : 'value'])), ...(fill.modes || {}) });
          return;
        }
        setFillNote(`${filled.length ? `Filled: ${filled.join(', ')}. ` : ''}${missing.length ? `Still needed: ${missing.join(', ')} — type them in the chat box and press Enter, or fill them below.` : 'Check the values, then press Generate Report.'}`);
      })
      .catch((e) => { if (!controller.signal.aborted) { setFillNote(''); setError(e instanceof Error ? e.message : 'Could not fill the form.'); setBusy(false); } });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.key, endpoint, sourceId]);
  async function choose(procedure: Procedure, fill?: Fill): Promise<Procedure | null> {
    setBusy(true); setError(''); setAllowBusinessWrites(false);
    try {
      const response = await fetch(`${endpoint}?sourceId=${encodeURIComponent(sourceId)}&procedureId=${procedure.id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      const current: Procedure = body.procedures[0];
      if (!current) throw new Error('Procedure unavailable.');
      setSelected(current);
      setModes({ ...Object.fromEntries(current.parameters.map(p => [p.name, p.output ? 'output' : p.hasDefault && !p.tableType ? 'default' : 'value'])), ...(fill?.modes || {}) });
      // A second message keeps what earlier messages filled and adds to it.
      setValues((previous) => ({ ...Object.fromEntries(current.parameters.map(p => [p.name, p.tableType ? [] : ''])), ...(selectedRef.current?.id === current.id ? Object.fromEntries(Object.entries(previous).filter(([, v]) => v !== '')) : {}), ...(fill?.values ? Object.fromEntries(Object.entries(fill.values).filter(([, v]) => v !== '')) : {}) }));
      if (!fill) setFillNote('Type the values in the chat box and press Enter (for example “last month, status 1”), or fill them below.');
      return current;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load parameters.'); return null; } finally { setBusy(false); }
  }
  async function submit(procedure: Procedure | null = selected, valuesNow = values, modesNow = modes) {
    if (!procedure) return;
    const selected = procedure; const values = valuesNow; const modes = modesNow;
    setBusy(true); setError('');
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const inputValues = Object.fromEntries(selected.parameters.filter(p => !['default', 'output'].includes(modes[p.name])).map(p => [p.name, modes[p.name] === 'null' ? null : values[p.name]]));
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run', sourceId, procedureId: selected.id, values: inputValues, omitted: selected.parameters.filter(p => modes[p.name] === 'default').map(p => p.name), hash: selected.hash, sessionId, allowBusinessWrites }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      onResult(body);
    } catch (e) { setError(controller.signal.aborted ? 'Report cancelled. If a write-capable procedure had already started, cancellation does not undo committed database changes.' : e instanceof Error ? e.message : 'Report failed.'); } finally { setBusy(false); abortRef.current = null; }
  }
  return <section aria-label="Stored procedure reports" className="mx-3 mb-3 max-h-[60vh] shrink-0 overflow-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{selected ? `${selected.schema}.${selected.name}` : 'Stored procedure reports'}</h3><button type="button" aria-label="Close report picker" title="Close" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
    {fillNote && <p role="status" className="mb-3 rounded-md border border-rose-100 bg-rose-50 p-2 text-sm text-rose-900">{fillNote}</p>}
    {!selected ? <><label className="mb-2 flex items-center gap-2 rounded-md border p-2"><Search size={16}/><input autoFocus aria-label="Search stored procedures, or describe the report and press Enter" placeholder="Search, or describe the report (e.g. collection summary for POP 12 last month) and press Enter" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => { const text = filter.replace(/^\/?(?:run\b)?\s*/i, '').trim(); if (e.key === 'Enter' && /\s/.test(text)) { e.preventDefault(); setTypedFill({ text, key: Date.now() }); } }} className="min-w-0 flex-1 text-sm outline-none"/></label>
      {pending ? <p role="status" className="text-sm text-zinc-500">Loading procedures…</p> : <div className="max-h-56 overflow-auto">{procedures.filter(p => `${p.schema}.${p.name}`.toLowerCase().includes(filter.toLowerCase())).map(p => <button type="button" disabled={busy} key={p.id} onClick={() => void choose(p)} className="block w-full break-all rounded-md px-3 py-2 text-left text-sm hover:bg-rose-50">{p.schema}.{p.name}</button>)}{!procedures.length && !error && <p className="text-sm text-zinc-500">No executable procedures were found for this database account.</p>}</div>}</> : <>
      {!selected.allowed && <p className="mb-3 text-sm text-amber-800">{selected.reason}</p>}
      {selected.allowed && selected.requiresWriteConsent && <p className="mb-3 text-sm text-amber-800">{selected.reason}</p>}
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{selected.parameters.map(p => <div key={p.name} className={`min-w-0 ${p.tableType ? 'sm:col-span-2' : ''}`}><label className="mb-1 block break-all text-sm" htmlFor={`procedure-${p.name}`}>{p.name.replace(/^@/, '')} <span className="text-xs text-zinc-400">{p.type}{p.output ? ' · input/output' : ''}</span></label>
          {p.tableType ? <TableInput parameter={p} rows={(values[p.name] || []) as Record<string, unknown>[]} disabled={busy} onChange={rows => setValues(v => ({ ...v, [p.name]: rows }))}/> : <>
            <select aria-label={`${p.name} value mode`} disabled={busy} value={modes[p.name] || 'value'} onChange={e => setModes(m => ({ ...m, [p.name]: e.target.value as ParameterMode }))} className="mb-2 h-9 w-full rounded-md border bg-white px-2 text-sm"><option value="value">Enter value{p.output ? ' and capture output' : ''}</option><option value="null">NULL{p.output ? ' and capture output' : ''}</option>{!p.output && <option value="default">Procedure default{p.hasDefault ? '' : ' (SQL Server validates)'}</option>}{p.output && <option value="output">Capture output only</option>}</select>
            {(!modes[p.name] || modes[p.name] === 'value') && <ScalarInput id={`procedure-${p.name}`} parameter={p} value={values[p.name]} disabled={busy} onChange={value => setValues(v => ({ ...v, [p.name]: value }))}/>}
          </>}
        </div>)}</div>
        {selected.requiresWriteConsent && <label className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><input type="checkbox" checked={allowBusinessWrites} disabled={busy} onChange={e => setAllowBusinessWrites(e.target.checked)}/>This procedure may change business records or execute other procedures. I authorize those changes for this run.</label>}
        <div className="mt-4 flex flex-wrap gap-2"><Button type="submit" disabled={busy || !selected.allowed || (selected.requiresWriteConsent && !allowBusinessWrites)}><Play size={14}/>{busy ? 'Running…' : 'Generate Report'}</Button>{busy && <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>Cancel run</Button>}<Button type="button" variant="outline" disabled={busy} onClick={() => { setSelected(null); setFillNote(''); }}>Back</Button></div>
      </form>
    </>}
  </section>;
}
