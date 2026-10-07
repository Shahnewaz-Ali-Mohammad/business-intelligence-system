'use client';

import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { ChartNoAxesCombined, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GraphOptions, GraphResult, GraphSource, ReportGraphSpec } from '@/lib/dashboard/report-graph';

const names = { bar: 'Bar', line: 'Line', kpi: 'KPI', histogram: 'Histogram', scatter: 'Scatter', density: 'Density' };
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const axis = (n: number) => compact.format(n);

export function ReportGraph({ source, title, spec, onChange }: { source: GraphSource | null; title: string; spec?: ReportGraphSpec | null; onChange: (spec: ReportGraphSpec | null) => void }) {
  const [result, setResult] = useState<GraphResult | null>(null);
  const [availableOptions, setAvailableOptions] = useState<GraphOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const loadedKey = useRef('');
  const pending = useRef<AbortController | null>(null);
  const key = JSON.stringify({ source, spec });
  useEffect(() => {
    if (!spec || !source || loadedKey.current === key) return;
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    const timer = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch('/api/graphs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'render', source, spec, title }), signal: controller.signal });
        const body = await res.json();
        if (!controller.signal.aborted && body.options) setAvailableOptions(body.options);
        if (!res.ok) throw new Error(body.error || 'Could not load graph.');
        if (!controller.signal.aborted) { loadedKey.current = key; setResult(body); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load graph.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
    // Serialized source/spec is the query identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => pending.current?.abort(), []);

  async function generate() {
    if (!source) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/graphs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate', source, title }), signal: controller.signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not generate graph.');
      if (controller.signal.aborted) return;
      loadedKey.current = JSON.stringify({ source, spec: body.spec });
      setAvailableOptions(body.options); setResult(body); onChange(body.spec);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not generate graph.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function change(patch: Partial<ReportGraphSpec>) {
    if (!spec) return;
    const next = { ...spec, ...patch, offset: patch.offset ?? 0 };
    if (patch.kind && options) {
      next.measure = options.measures.some((f) => f.name === next.measure) ? next.measure : options.defaultMeasure;
      next.dimension = options.categories.some((f) => f.name === next.dimension) ? next.dimension : options.defaultCategory;
      next.time = options.times.some((f) => f.name === next.time) ? next.time : options.defaultTime;
      next.x = options.numerics.some((f) => f.name === next.x) ? next.x : options.numerics[0]?.name;
      next.y = options.numerics.find((f) => f.name === next.y && f.name !== next.x)?.name || options.numerics.find((f) => f.name !== next.x)?.name;
    }
    if (patch.x && next.y === patch.x) next.y = options?.numerics.find((f) => f.name !== patch.x)?.name;
    if (patch.y && next.x === patch.y) next.x = options?.numerics.find((f) => f.name !== patch.y)?.name;
    if (['kind', 'measure', 'dimension', 'time', 'x', 'y'].some((f) => f in patch)) {
      next.title = next.kind === 'bar' ? `${fieldLabel(next.measure)} by ${fieldLabel(next.dimension)}` : next.kind === 'line' ? `${fieldLabel(next.measure)} over time` : next.kind === 'kpi' ? fieldLabel(next.measure) : next.kind === 'histogram' ? `Distribution of ${fieldLabel(next.x)}` : `${fieldLabel(next.y)} vs ${fieldLabel(next.x)}`;
    }
    setError(null); setLoading(JSON.stringify({ source, spec: next }) !== loadedKey.current); onChange(next);
  }
  const options = availableOptions || result?.options;
  const column = !spec ? '' : spec.kind === 'bar' ? spec.dimension : spec.kind === 'line' ? spec.time : spec.kind === 'kpi' ? spec.measure : spec.x;
  const tables = [...new Set(options?.columns.map((f) => f.table || 'Report') || [])];
  function chooseColumn(member: string) {
    if (!options) return;
    if (options.measures.some((f) => f.name === member) && !options.kinds.includes('kpi')) change({ measure: member });
    else if (options.times.some((f) => f.name === member) && options.kinds.includes('line')) change({ kind: 'line', time: member, granularity: options.fixedGranularity || 'day', filters: [] });
    else if (options.numerics.some((f) => f.name === member) && options.kinds.includes('histogram')) change({ kind: 'histogram', x: member, filters: [] });
    else if (options.categories.some((f) => f.name === member)) change({ kind: 'bar', dimension: member, filters: [] });
    else change({ kind: 'kpi', measure: member, filters: [] });
  }
  const fieldLabel = (name?: string) => [...(options?.measures || []), ...(options?.categories || []), ...(options?.times || []), ...(options?.numerics || [])].find((f) => f.name === name)?.title || '';
  const current = result?.spec;
  const plot = (result?.rows || []).map((r) => ({ ...r, amount: r.value === '' ? null : Number(r.value) }));
  const invalid = plot.some((p) => p.amount !== null && !Number.isFinite(p.amount));
  const selector = 'h-8 max-w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 sm:max-w-56';
  return <section className="min-w-0 border-t border-slate-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {!spec ? <Button type="button" size="sm" variant="outline" className="gap-2" disabled={loading || !source} title={!source ? 'This report has no saved database query. Generate a new report first.' : undefined} onClick={generate}>{loading ? <LoaderCircle size={15} className="animate-spin" /> : <ChartNoAxesCombined size={15} />}{loading ? 'Generating graph...' : 'Generate graph'}</Button> : <h3 className="min-w-0 break-words text-sm font-semibold text-slate-800">{spec.title}</h3>}
      {spec && <div className="flex max-w-full flex-wrap items-center gap-2">
        {options && <select aria-label="Graph style" value={options.kinds.includes(spec.kind) ? spec.kind : ''} className={selector} disabled={loading} onChange={(e) => change({ kind: e.target.value as ReportGraphSpec['kind'] })}>{!options.kinds.includes(spec.kind) && <option value="" disabled>Choose style</option>}{options.kinds.map((k) => <option key={k} value={k}>{names[k]}</option>)}</select>}
        {spec.kind === 'bar' && <button type="button" title="Graph ordering" aria-label="Graph settings" aria-expanded={settings} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200" onClick={() => setSettings(!settings)}><Settings2 size={15} /></button>}
        <button type="button" title="Recommend a new graph" aria-label="Recommend a new graph" disabled={loading} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 disabled:opacity-40" onClick={generate}><RefreshCw size={15} /></button>
        <button type="button" title="Remove graph" aria-label="Remove graph" className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200" onClick={() => { pending.current?.abort(); setLoading(false); setError(null); setResult(null); onChange(null); }}><X size={15} /></button>
      </div>}
    </div>
    {spec && options && <div className="mt-3 flex flex-wrap items-end gap-3 border-b border-slate-100 pb-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-500">Column<select aria-label="Graph column" className={selector} value={column || ''} disabled={loading} onChange={(e) => chooseColumn(e.target.value)}>{!options.columns.some((f) => f.name === column) && <option value="" disabled>Choose report column</option>}{tables.map((table) => <optgroup key={table} label={table}>{options.columns.filter((f) => (f.table || 'Report') === table).map((f) => <option key={f.name} value={f.name}>{f.title}</option>)}</optgroup>)}</select></label>
      {['bar', 'line', 'kpi'].includes(spec.kind) && <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-500">Value<select aria-label="Graph metric" className={selector} value={spec.measure} disabled={loading} onChange={(e) => change({ measure: e.target.value })}>{options.measures.map((f) => <option key={f.name} value={f.name}>{f.title}</option>)}</select></label>}
      {['scatter', 'density'].includes(spec.kind) && <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-500">Compare with<select aria-label="Graph Y field" className={selector} value={spec.y} disabled={loading} onChange={(e) => change({ y: e.target.value })}>{options.numerics.filter((f) => f.name !== spec.x).map((f) => <option key={f.name} value={f.name}>{f.title}</option>)}</select></label>}
      {spec.kind === 'line' && <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-500">Interval<select aria-label="Graph interval" className={selector} value={spec.granularity} disabled={loading} onChange={(e) => change({ granularity: e.target.value })}>{(options.fixedGranularity ? [options.fixedGranularity] : ['hour', 'day', 'week', 'month', 'quarter', 'year']).map((g) => <option key={g}>{g}</option>)}</select></label>}
    </div>}
    {spec && options?.columns.find((f) => f.name === column)?.table && <p className="mt-2 break-all text-xs text-slate-500">Table: {options.columns.find((f) => f.name === column)?.table}</p>}
    {spec?.kind === 'bar' && settings && options && <div className="mt-3 flex flex-wrap items-end gap-3 border-b border-slate-100 pb-3">
      {spec.kind === 'bar' && <select aria-label="Graph ordering" className={selector} value={spec.direction} onChange={(e) => change({ direction: e.target.value as 'asc' | 'desc' })}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select>}
    </div>}
    {!!spec?.filters.length && <div className="mt-3 flex flex-wrap gap-2">{spec.filters.map((f) => <button type="button" key={f.member} title="Remove graph filter" className="flex max-w-full items-center gap-2 rounded border border-slate-200 px-2 py-1 text-xs" onClick={() => change({ filters: spec.filters.filter((v) => v !== f) })}><span className="truncate">{fieldLabel(f.member)}: {f.values[0] || 'Unassigned'}</span><X size={12} className="shrink-0" /></button>)}</div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {spec && result && result.mode === 'aggregate' && ['bar', 'line'].includes(spec.kind) && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 text-xs text-slate-600">
      <p aria-live="polite">Groups {result.total ? (current?.offset ?? 0) + 1 : 0}–{Math.min((current?.offset ?? 0) + result.rows.length, result.total)} of {result.total.toLocaleString()}</p>
      <div className="flex flex-wrap items-center gap-2"><select aria-label="Groups per graph page" className={selector} value={spec.pageSize ?? 50} disabled={loading} onChange={(e) => change({ pageSize: Number(e.target.value) })}>{[20, 50, 100].map((n) => <option key={n} value={n}>{n} groups</option>)}</select><button type="button" aria-label="Previous graph page" title="Previous graph page" disabled={loading || !spec.offset} className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 disabled:opacity-30" onClick={() => change({ offset: Math.max(0, spec.offset - result.pageSize) })}><ChevronLeft size={16} /></button><span>Page {Math.floor((current?.offset ?? 0) / result.pageSize) + 1} of {Math.max(1, Math.ceil(result.total / result.pageSize)).toLocaleString()}</span><button type="button" aria-label="Next graph page" title="Next graph page" disabled={loading || spec.offset + result.pageSize >= result.total} className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 disabled:opacity-30" onClick={() => change({ offset: spec.offset + result.pageSize })}><ChevronRight size={16} /></button></div>
    </div>}
    {spec && <div className="relative mt-4 min-w-0" aria-busy={loading}>
      {loading && <div role="status" className="flex h-80 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle size={16} className="animate-spin" />Loading graph...</div>}
      {!loading && !error && result && current && (invalid ? <p role="alert" className="py-6 text-sm text-red-600">These values cannot be represented on a numeric axis.</p> : !plot.length ? <p className="flex h-80 items-center justify-center text-sm text-slate-500">No matching graph data</p> : current.kind === 'kpi' ? <div className="flex min-h-40 flex-col justify-center gap-2"><p className="break-words text-4xl font-semibold text-slate-800">{plot[0].value === '' ? 'No value' : Number(plot[0].value).toLocaleString(undefined, { maximumFractionDigits: 4 })}</p><p className="text-sm text-slate-500">{fieldLabel(current.measure)}</p></div> : ['scatter', 'density'].includes(current.kind) && result.mode === 'bins' ? <DensityGraph result={result} /> : current.kind === 'bar' ? <div className="max-h-96 overflow-y-auto overscroll-contain" aria-label="Scrollable graph groups"><div style={{ height: Math.max(200, plot.length * 32 + 40) }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 320, height: 320 }}><BarChart layout="vertical" data={plot} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}><CartesianGrid horizontal={false} stroke="#e5e7eb" /><XAxis type="number" tickFormatter={axis} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="label" width={140} interval={0} tick={{ fontSize: 11 }} tickFormatter={(v) => String(v).length > 24 ? `${String(v).slice(0, 22)}...` : String(v)} /><Tooltip formatter={(value) => Number(value).toLocaleString()} /><Bar name={fieldLabel(current.measure)} dataKey="amount" fill="#be185d" maxBarSize={18} isAnimationActive={false} /></BarChart></ResponsiveContainer>
      </div></div> : <div className="h-80 min-w-0 w-full">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 320, height: 320 }}>
          {current.kind === 'line' ? <LineChart data={plot} margin={{ top: 12, right: 12, bottom: 15, left: 0 }}><CartesianGrid vertical={false} stroke="#e5e7eb" /><XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={35} tickFormatter={(v) => String(v).slice(0, current.granularity === 'hour' ? 13 : 10)} /><YAxis tickFormatter={axis} tick={{ fontSize: 11 }} /><Tooltip /><Line name={fieldLabel(current.measure)} dataKey="amount" stroke="#be185d" strokeWidth={2} dot={plot.length < 20} connectNulls={false} isAnimationActive={false} /></LineChart> : current.kind === 'scatter' ? <ScatterChart margin={{ top: 12, right: 20, bottom: 15, left: 0 }}><CartesianGrid stroke="#e5e7eb" /><XAxis type="number" dataKey="x" name={fieldLabel(current.x)} tickFormatter={axis} tick={{ fontSize: 11 }} /><YAxis type="number" dataKey="y" name={fieldLabel(current.y)} tickFormatter={axis} tick={{ fontSize: 11 }} /><ZAxis dataKey="amount" range={[40, 240]} name="Records" /><Tooltip cursor={{ strokeDasharray: '3 3' }} /><Scatter data={plot} fill="#be185d" isAnimationActive={false} /></ScatterChart> : <BarChart data={plot} margin={{ top: 12, right: 12, bottom: 15, left: 0 }}><CartesianGrid vertical={false} stroke="#e5e7eb" /><XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" tickFormatter={(v) => String(v).length > 22 ? `${String(v).slice(0, 20)}...` : String(v)} /><YAxis tickFormatter={axis} tick={{ fontSize: 11 }} /><Tooltip /><Bar name="Records" dataKey="amount" fill="#be185d" maxBarSize={44} isAnimationActive={false} /></BarChart>}
        </ResponsiveContainer>
      </div>)}
      {result && !loading && !error && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <p className="min-w-0 break-words">{result.mode === 'aggregate' ? `${current?.kind === 'kpi' ? 'Full filtered population' : `Groups ${result.total ? spec.offset + 1 : 0}-${Math.min(spec.offset + result.pageSize, result.total)} of ${result.total.toLocaleString()}`} · Database aggregated` : `${Number(result.included).toLocaleString()} of ${Number(result.population).toLocaleString()} records with usable numeric values · ${result.mode === 'points' ? 'Exact points' : current?.kind === 'histogram' ? '20 numeric bins' : '20 × 20 density bins'}`} · Live {new Date(result.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
        {current?.kind === 'bar' && <p>Each bar is a group, not an individual record.</p>}
      </div>}
    </div>}
  </section>;
}

function DensityGraph({ result }: { result: GraphResult }) {
  const max = Math.max(1, ...result.rows.map((r) => Number(r.value)));
  const cells = new Map(result.rows.map((r) => [`${r.x}:${r.y}`, r.value]));
  const b = result.bounds!;
  const range = (min: string | undefined, max: string | undefined, index: number) => `${axis(Number(min) + (Number(max) - Number(min)) * index / 20)} - ${axis(Number(min) + (Number(max) - Number(min)) * (index + 1) / 20)}`;
  const label = (name?: string) => result.options.numerics.find((f) => f.name === name)?.title || '';
  return <div className="mx-auto max-w-lg"><p className="mb-2 break-words text-xs text-slate-600">{label(result.spec.y)} vs {label(result.spec.x)}</p><div className="mb-2 flex justify-between text-xs text-slate-500"><span>Y: {axis(Number(b.ymin))}</span><span>{axis(Number(b.ymax))}</span></div><div className="grid aspect-square w-full gap-px border border-slate-200" style={{ gridTemplateColumns: 'repeat(20,minmax(0,1fr))' }}>{Array.from({ length: 400 }, (_, i) => { const x = i % 20, y = 19 - Math.floor(i / 20), value = cells.get(`${x}:${y}`); return <div key={i} title={`X ${range(b.xmin, b.xmax, x)}; Y ${range(b.ymin, b.ymax, y)}; ${value || '0'} records`} style={{ background: value ? `rgba(190,24,93,${0.12 + 0.88 * Math.log1p(Number(value)) / Math.log1p(max)})` : '#fafafa' }} />; })}</div><div className="mt-2 flex justify-between text-xs text-slate-500"><span>X: {axis(Number(b.xmin))}</span><span>{axis(Number(b.xmax))}</span></div></div>;
}
