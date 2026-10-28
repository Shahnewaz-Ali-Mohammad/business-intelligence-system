'use client';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Lightbulb } from 'lucide-react';
import type { Block } from '@/lib/designer/spec';

export type BlockData = { rows: Record<string, unknown>[]; hasMore: boolean; error?: string };

// Fixed categorical order: identity follows the series, never its rank.
export const SERIES = ['#be123c', '#2563eb', '#0d9488', '#d97706', '#7c3aed', '#475569'];

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : null);
export const label = (key: string) => key.replace(/^.*[:.]/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());

export function formatValue(v: unknown, format: Block['format'], compact = false) {
  const n = num(v);
  if (n == null) return v == null ? '—' : String(v);
  if (format === 'percent') return `${(Math.abs(n) <= 1 ? n * 100 : n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  const opts: Intl.NumberFormatOptions = compact && Math.abs(n) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 };
  return (format === 'currency' ? '' : '') + n.toLocaleString(undefined, opts);
}

/** Picks the category column and the numeric series from the result rows. */
export function shape(rows: Record<string, unknown>[]) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const numeric = keys.filter((k) => rows.every((r) => r[k] == null || num(r[k]) != null));
  const x = keys.find((k) => !numeric.includes(k)) ?? keys[0];
  const ys = numeric.filter((k) => k !== x).slice(0, 4);
  const data = rows.map((r) => ({ ...r, [x]: r[x] == null ? '(blank)' : String(r[x]), ...Object.fromEntries(ys.map((y) => [y, num(r[y]) ?? 0])) }));
  return { x, ys, data };
}

const axis = { stroke: '#a1a1aa', fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { contentStyle: { borderRadius: 10, border: '1px solid #e4e4e7', boxShadow: '0 8px 24px rgba(0,0,0,.08)', fontSize: 12 }, cursor: { fill: 'rgba(0,0,0,.04)' } };

function Chart({ block, rows }: { block: Block; rows: Record<string, unknown>[] }) {
  const { x, ys, data } = shape(rows);
  if (!ys.length) return <Empty text="No numbers to chart in this data." />;
  const fmt = (v: unknown) => formatValue(v, block.format, true);
  const legend = ys.length > 1 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-zinc-600">{label(String(v))}</span>} /> : null;
  const kind = block.chartKind || 'bar';
  if (kind === 'pie') {
    const y = ys[0];
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={data} dataKey={y} nameKey={x} innerRadius="55%" outerRadius="85%" paddingAngle={1} stroke="#fff" strokeWidth={2}>
            {data.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
          </Pie>
          <Tooltip {...tip} formatter={(v) => fmt(v)} />
          <Legend iconType="circle" iconSize={8} layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-zinc-600">{String(v)}</span>} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (kind === 'line' || kind === 'area') {
    const C = kind === 'line' ? LineChart : AreaChart;
    return (
      <ResponsiveContainer width="100%" height={280}>
        <C data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>{ys.map((y, i) => <linearGradient key={y} id={`g-${block.id}-${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES[i]} stopOpacity={0.25} /><stop offset="100%" stopColor={SERIES[i]} stopOpacity={0} /></linearGradient>)}</defs>
          <CartesianGrid vertical={false} stroke="#f1f1f3" />
          <XAxis dataKey={x} {...axis} minTickGap={16} />
          <YAxis {...axis} width={56} tickFormatter={fmt} />
          <Tooltip {...tip} formatter={(v, n) => [fmt(v), label(String(n))]} cursor={{ stroke: '#d4d4d8' }} />
          {legend}
          {ys.map((y, i) => kind === 'line'
            ? <Line key={y} type="monotone" dataKey={y} stroke={SERIES[i]} strokeWidth={2} dot={data.length <= 24 ? { r: 3, strokeWidth: 2, fill: '#fff' } : false} activeDot={{ r: 5 }} />
            : <Area key={y} type="monotone" dataKey={y} stroke={SERIES[i]} strokeWidth={2} fill={`url(#g-${block.id}-${i})`} />)}
        </C>
      </ResponsiveContainer>
    );
  }
  const horizontal = kind === 'hbar';
  return (
    <ResponsiveContainer width="100%" height={horizontal ? Math.max(220, data.length * 28 + 40) : 280}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="#f1f1f3" />
        {horizontal ? <><XAxis type="number" {...axis} tickFormatter={fmt} /><YAxis type="category" dataKey={x} {...axis} width={120} /></>
          : <><XAxis dataKey={x} {...axis} minTickGap={8} /><YAxis {...axis} width={56} tickFormatter={fmt} /></>}
        <Tooltip {...tip} formatter={(v, n) => [fmt(v), label(String(n))]} />
        {legend}
        {ys.map((y, i) => <Bar key={y} dataKey={y} fill={SERIES[i]} stackId={kind === 'stacked' ? 's' : undefined} radius={kind === 'stacked' && i < ys.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={44} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}

function Table({ block, rows, hasMore }: { block: Block; rows: Record<string, unknown>[]; hasMore: boolean }) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const numeric = new Set(keys.filter((k) => rows.every((r) => r[k] == null || num(r[k]) != null)));
  return (
    <div>
      <div className="max-h-[420px] overflow-auto rounded-lg border border-zinc-100">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-50/95 backdrop-blur"><tr>{keys.map((k) => <th key={k} className={`whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 ${numeric.has(k) ? 'text-right' : 'text-left'}`}>{label(k)}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-zinc-100 hover:bg-rose-50/40">{keys.map((k) => <td key={k} className={`whitespace-nowrap px-3 py-2 ${numeric.has(k) ? 'text-right tabular-nums' : ''}`}>{numeric.has(k) ? formatValue(r[k], block.format) : r[k] == null ? '—' : String(r[k])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-400">{rows.length.toLocaleString()} rows{hasMore ? ' shown · more in the full export' : ''}</p>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <div className="flex h-40 items-center justify-center rounded-lg bg-zinc-50 text-sm text-zinc-400">{text}</div>;
export const Skeleton = ({ h = 'h-56' }: { h?: string }) => <div className={`${h} animate-pulse rounded-lg bg-gradient-to-r from-zinc-100 via-zinc-50 to-zinc-100`} />;

export function BlockBody({ block, data, loading }: { block: Block; data?: BlockData; loading: boolean }) {
  if (block.type === 'heading') return (
    <div className="pt-2">
      <h2 className="text-lg font-bold tracking-tight text-zinc-900">{block.title}</h2>
      {block.text && <p className="mt-1 text-sm text-zinc-500">{block.text}</p>}
    </div>
  );
  if (block.type === 'text') return <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{block.text}</p>;
  if (block.type === 'insight') return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600"><Lightbulb size={15} /></div>
      {loading && !block.text ? <div className="flex-1 space-y-2"><Skeleton h="h-3" /><Skeleton h="h-3" /></div> : <p className="text-sm leading-relaxed text-zinc-700">{block.text || 'The analysis appears once its chart has data.'}</p>}
    </div>
  );
  if (loading && !data) return <Skeleton h={block.type === 'kpi' ? 'h-12' : 'h-56'} />;
  if (data?.error) return <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800"><AlertTriangle size={15} />{data.error}</div>;
  const rows = data?.rows || [];
  if (block.type === 'kpi') {
    const first = rows[0] || {};
    const key = Object.keys(first).find((k) => num(first[k]) != null);
    return <p className="text-3xl font-bold tracking-tight text-zinc-900 tabular-nums">{key ? formatValue(first[key], block.format, true) : '—'}</p>;
  }
  if (!rows.length) return <Empty text="No records match." />;
  if (block.type === 'chart') return <Chart block={block} rows={rows} />;
  return <Table block={block} rows={rows} hasMore={!!data?.hasMore} />;
}
