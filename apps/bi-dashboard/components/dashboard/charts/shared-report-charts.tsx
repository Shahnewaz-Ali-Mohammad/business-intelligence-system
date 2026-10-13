'use client';

import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronLeft, ChevronRight, RotateCcw, Search, X } from 'lucide-react';
import type { ChartSpec } from '@/lib/dashboard/chart-spec';

type Exploration = NonNullable<ChartSpec['exploration']>;
type Panel = Exploration['panels'][number];
type Options = {
  measures: { name: string; type: string }[];
  dimensions: { name: string; type: string }[];
  times: { name: string; type: string }[];
  defaultMeasure: string; defaultDimension: string; defaultTime?: string;
};
type Result = { rows: Record<string, unknown>[]; total: number; timeTotal?: number; partial?: boolean; options: Options };
const label = (member: string) => member.split('.').slice(1).join(' ').replaceAll('_', ' ');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const defaults: Exploration = { filters: [], panels: [{ kind: 'bar', pageSize: 20 }, { kind: 'line', granularity: 'month', pageSize: 60 }, { kind: 'heatmap', granularity: 'month', pageSize: 20 }] };

export function SharedReportCharts({ query, spec, onSpecChange }: { query: Record<string, unknown>; spec: ChartSpec; onSpecChange?: (spec: ChartSpec) => void }) {
  const exploration = spec.exploration ?? defaults;
  function update(next: Exploration) { onSpecChange?.({ ...spec, exploration: next }); }
  function select(member: string, value: string | null) {
    update({ ...exploration, filters: [...exploration.filters.filter((f) => f.member !== member), { member, operator: value === null ? 'notSet' : 'equals', values: value === null ? [] : [value] }], panels: exploration.panels.map((p) => ({ ...p, offset: 0, timeOffset: 0 })) });
  }
  return <div className="space-y-5">
    {exploration.filters.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-3">
      {exploration.filters.map((filter) => <button key={filter.member} type="button" className="inline-flex items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-xs" onClick={() => update({ ...exploration, filters: exploration.filters.filter((f) => f !== filter), panels: exploration.panels.map((p) => ({ ...p, offset: 0 })) })}>
        {label(filter.member)}: {filter.operator === 'notSet' ? 'Unassigned' : filter.values.join(', ')} <X size={12} />
      </button>)}
      <button type="button" title="Clear graph filters" onClick={() => update({ ...exploration, filters: [], panels: exploration.panels.map((p) => ({ ...p, offset: 0 })) })}><RotateCcw size={15} /></button>
    </div>}
    {exploration.panels.map((panel, index) => <GraphPanel key={index} query={query} panel={panel} filters={exploration.filters} onSelect={select} onChange={(next) => update({ ...exploration, panels: exploration.panels.map((p, i) => i === index ? next : p) })} />)}
  </div>;
}

function GraphPanel({ query, panel, filters, onChange, onSelect }: {
  query: Record<string, unknown>; panel: Panel; filters: Exploration['filters']; onChange: (panel: Panel) => void; onSelect: (member: string, value: string | null) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestKey = JSON.stringify({ query, config: panel, filters });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const response = await fetch('/api/charts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestKey, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) {
          if (body.options && !controller.signal.aborted) setResult({ options: body.options, rows: [], total: 0 });
          throw new Error(body.error || 'Could not load graph.');
        }
        if (!controller.signal.aborted) setResult(body);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load graph.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [requestKey]);
  const options = result?.options;
  const measure = panel.measure || options?.defaultMeasure || '';
  const dimension = panel.dimension || options?.defaultDimension || '';
  const time = panel.time || options?.defaultTime || '';
  const size = panel.pageSize ?? (panel.kind === 'line' ? 60 : 20);
  const offset = panel.offset ?? 0;
  const points = (result?.rows ?? []).map((row) => {
    const timeKey = Object.keys(row).find((k) => k.startsWith(`${time}.`)) || time;
    return { category: String(row[dimension] ?? 'Unassigned'), missingCategory: row[dimension] == null, time: String(row[timeKey] ?? ''), value: row[measure] == null ? null : Number(row[measure]) };
  });
  const change = (patch: Partial<Panel>) => onChange({ ...panel, ...patch, offset: patch.offset ?? 0, timeOffset: patch.timeOffset ?? 0 });
  return <section className="border-b border-zinc-200 pb-5 last:border-b-0">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold capitalize text-zinc-800">{panel.kind === 'bar' ? 'Category comparison' : panel.kind === 'line' ? 'Time trend' : 'Category over time'}</h3>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="Graph style" className="h-8 rounded border border-zinc-200 bg-white px-2" value={panel.kind} onChange={(e) => change({ kind: e.target.value as Panel['kind'] })}>
          <option value="bar">Bar</option><option value="line">Line</option><option value="heatmap">Heatmap</option>
        </select>
        {options && <>
          <select aria-label="Graph measure" className="h-8 max-w-48 rounded border border-zinc-200 bg-white px-2" value={measure} onChange={(e) => change({ measure: e.target.value })}>{options.measures.map((m) => <option key={m.name} value={m.name}>{label(m.name)}</option>)}</select>
          {panel.kind !== 'line' && <select aria-label="Graph category" className="h-8 max-w-48 rounded border border-zinc-200 bg-white px-2" value={dimension} onChange={(e) => change({ dimension: e.target.value })}>{options.dimensions.map((d) => <option key={d.name} value={d.name}>{label(d.name)}</option>)}</select>}
          {panel.kind !== 'bar' && <>
            <select aria-label="Graph date field" className="h-8 max-w-48 rounded border border-zinc-200 bg-white px-2" value={time} onChange={(e) => change({ time: e.target.value })}>{options.times.map((d) => <option key={d.name} value={d.name}>{label(d.name)}</option>)}</select>
            <select aria-label="Time interval" className="h-8 rounded border border-zinc-200 bg-white px-2" value={panel.granularity ?? 'month'} onChange={(e) => change({ granularity: e.target.value })}>{['hour', 'day', 'week', 'month', 'quarter', 'year'].map((g) => <option key={g} value={g}>{g}</option>)}</select>
          </>}
        </>}
      </div>
    </div>
    {panel.kind !== 'line' && <div className="mb-3 flex flex-wrap items-center gap-2">
      <label className="flex h-8 items-center gap-2 rounded border border-zinc-200 px-2"><Search size={14} /><input aria-label="Search graph categories" className="w-40 bg-transparent text-xs outline-none" placeholder="Search categories" value={panel.search ?? ''} onChange={(e) => change({ search: e.target.value })} /></label>
      <select aria-label="Category ordering" className="h-8 rounded border border-zinc-200 text-xs" value={panel.direction ?? 'desc'} onChange={(e) => change({ direction: e.target.value as 'asc' | 'desc' })}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select>
    </div>}
    {error ? <p role="alert" className="py-6 text-sm text-red-600">{error}</p> : <div className={loading ? 'pointer-events-none opacity-50' : ''} aria-busy={loading}>
      {!points.length ? <div className="flex h-72 items-center justify-center text-sm text-zinc-500">{loading ? 'Loading graph...' : 'No matching graph data'}</div> : panel.kind === 'heatmap' ? <Heatmap points={points} granularity={panel.granularity} onSelect={(value) => onSelect(dimension, value)} /> : <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">{panel.kind === 'line' ? <LineChart data={points} margin={{ top: 8, right: 16, bottom: 20, left: 8 }}>
          <CartesianGrid vertical={false} stroke="#e5e7eb" /><XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={40} tickFormatter={(v) => String(v).slice(0, panel.granularity === 'hour' ? 13 : 10)} /><YAxis tickFormatter={(v) => compact.format(v)} tick={{ fontSize: 11 }} /><Tooltip formatter={(v) => [Number(v).toLocaleString(), label(measure)]} /><Line dataKey="value" stroke="#be123c" strokeWidth={2} dot={points.length <= 20} connectNulls={false} />
        </LineChart> : <BarChart data={points} margin={{ top: 8, right: 16, bottom: 20, left: 8 }}>
          <CartesianGrid vertical={false} stroke="#e5e7eb" /><XAxis dataKey="category" tick={{ fontSize: 11 }} interval="preserveStartEnd" /><YAxis tickFormatter={(v) => compact.format(v)} tick={{ fontSize: 11 }} /><Tooltip formatter={(v) => [Number(v).toLocaleString(), label(measure)]} /><Bar dataKey="value" fill="#be123c" maxBarSize={40} onClick={(_point, index) => onSelect(dimension, points[index].missingCategory ? null : points[index].category)} />
        </BarChart>}</ResponsiveContainer>
      </div>}
    </div>}
    {result && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
      <span>{panel.kind === 'heatmap' ? 'Category window' : 'Result window'} {result.total ? offset + 1 : 0}–{Math.min(offset + size, result.total)} of {result.total.toLocaleString()}{result.partial ? ' · Zoom to a coarser interval to see all time cells' : ''}</span>
      <div className="flex items-center gap-2">
        <select aria-label="Graph window size" className="h-7 rounded border border-zinc-200" value={size} onChange={(e) => change({ pageSize: Number(e.target.value) })}>{Array.from(new Set([10, 20, 60, 100, size])).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <button type="button" title="Previous graph window" disabled={loading || offset === 0} className="disabled:opacity-30" onClick={() => change({ offset: Math.max(0, offset - size) })}><ChevronLeft size={18} /></button>
        <button type="button" title="Next graph window" disabled={loading || offset + size >= result.total} className="disabled:opacity-30" onClick={() => change({ offset: offset + size })}><ChevronRight size={18} /></button>
      </div>
    </div>}
    {panel.kind === 'heatmap' && result?.timeTotal != null && <div className="mt-2 flex items-center justify-end gap-2 text-xs text-zinc-500">
      <span>Time window {(panel.timeOffset ?? 0) + 1}–{Math.min((panel.timeOffset ?? 0) + 20, result.timeTotal)} of {result.timeTotal}</span>
      <button type="button" title="Previous time window" disabled={loading || !panel.timeOffset} className="disabled:opacity-30" onClick={() => onChange({ ...panel, timeOffset: Math.max(0, (panel.timeOffset ?? 0) - 20) })}><ChevronLeft size={18} /></button>
      <button type="button" title="Next time window" disabled={loading || (panel.timeOffset ?? 0) + 20 >= result.timeTotal} className="disabled:opacity-30" onClick={() => onChange({ ...panel, timeOffset: (panel.timeOffset ?? 0) + 20 })}><ChevronRight size={18} /></button>
    </div>}
  </section>;
}

function Heatmap({ points, onSelect, granularity }: { points: { category: string; missingCategory: boolean; time: string; value: number | null }[]; granularity?: string; onSelect: (value: string | null) => void }) {
  const categories = [...new Set(points.map((p) => p.missingCategory ? null : p.category))];
  const times = [...new Set(points.map((p) => p.time))].sort();
  const cells = new Map(points.map((p) => [JSON.stringify([p.missingCategory ? null : p.category, p.time]), p.value]));
  const max = Math.max(1, ...points.map((p) => Math.abs(p.value ?? 0)));
  return <div className="max-h-96 overflow-auto"><table className="w-full border-separate border-spacing-1 text-xs">
    <thead><tr><th className="sticky left-0 min-w-32 bg-white" />{times.map((time) => <th key={time} className="min-w-20 font-normal text-zinc-500">{time.slice(0, granularity === 'hour' ? 13 : 10)}</th>)}</tr></thead>
    <tbody>{categories.map((category) => <tr key={JSON.stringify(category)}><th className="sticky left-0 max-w-48 bg-white pr-3 text-left font-normal"><button type="button" onClick={() => onSelect(category)} className="block max-w-40 truncate text-rose-800" title={category ?? 'Unassigned'}>{category ?? 'Unassigned'}</button></th>{times.map((time) => {
      const value = cells.get(JSON.stringify([category, time]));
      const intensity = Math.abs(value ?? 0) / max;
      return <td key={time} title={`${category} · ${time}: ${value == null ? 'No value' : value.toLocaleString()}`} className="h-9 min-w-20 rounded text-center" style={{ background: value == null ? '#f3f4f6' : `rgba(${value < 0 ? '225,29,72' : '190,18,60'},${0.08 + intensity * 0.85})`, color: intensity > 0.55 ? '#ffffff' : '#374151' }}>{value == null ? '—' : compact.format(value)}</td>;
    })}</tr>)}</tbody>
  </table></div>;
}
