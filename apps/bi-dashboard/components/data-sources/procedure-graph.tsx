'use client';
import { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { aggregateProcedureGraph } from '@/lib/tool-setup/procedure-graph.mjs';
type GraphData = { rows: { category: string; value: number | null }[]; scope: string; hasMore: boolean };
export type ProcedureGraphSettings = { category: string; metric: string; aggregation: string; data?: GraphData };
export function ProcedureGraph({ workspaceId, runId, resultIndex, columns, rows, initial, onChange }: { workspaceId: string; runId?: string; resultIndex: number; columns: string[]; rows: Record<string, unknown>[]; initial?: ProcedureGraphSettings; onChange: (settings: ProcedureGraphSettings) => void }) {
  const numeric = columns.filter(column => !/(?:id|code|_sk)$/i.test(column) && rows.some(row => row[column] != null && row[column] !== '') && rows.every(row => row[column] == null || row[column] === '' || Number.isFinite(Number(row[column]))));
  const [category, setCategory] = useState(initial?.category || columns.find(column => !numeric.includes(column) && !/(?:id|code|_sk)$/i.test(column)) || columns[0] || '');
  const [metric, setMetric] = useState(initial?.metric ?? numeric[0] ?? '');
  const [aggregation, setAggregation] = useState(initial?.aggregation || 'sum');
  const [data, setData] = useState(initial?.data);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const changeRef = useRef(onChange); const rowsRef = useRef(rows); const columnsRef = useRef(columns);
  useEffect(() => { changeRef.current = onChange; rowsRef.current = rows; columnsRef.current = columns; });
  useEffect(() => {
    const controller = new AbortController();
    async function generate() {
      setLoading(true); setError('');
      try {
        let graph;
        if (runId) {
          const query = new URLSearchParams({ set: String(resultIndex), category, metric, aggregation });
          const response = await fetch(`/api/workspaces/${workspaceId}/procedures/runs/${runId}/graph?${query}`, { signal: controller.signal });
          graph = await response.json(); if (!response.ok) throw new Error(graph.error);
        } else graph = await aggregateProcedureGraph(rowsRef.current, columnsRef.current, { category, metric: metric || null, aggregation, signal: controller.signal });
        if (!controller.signal.aborted) { setData(graph); changeRef.current({ category, metric, aggregation, data: graph }); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Graph failed.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    if (category) void generate();
    return () => controller.abort();
  }, [workspaceId, runId, resultIndex, category, metric, aggregation]);
  return <div className="space-y-3 border-y border-zinc-100 py-4"><div className="flex flex-wrap gap-3"><label className="min-w-0 text-xs text-zinc-500">Group by<select aria-label="Graph grouping column" className="mt-1 block h-9 max-w-full rounded-md border bg-white px-2 text-sm text-zinc-800" value={category} onChange={e => setCategory(e.target.value)}>{columns.map(column => <option key={column}>{column}</option>)}</select></label><label className="text-xs text-zinc-500">Metric<select aria-label="Graph metric" className="mt-1 block h-9 max-w-full rounded-md border bg-white px-2 text-sm text-zinc-800" value={metric} onChange={e => setMetric(e.target.value)}><option value="">Record count</option>{numeric.map(column => <option key={column}>{column}</option>)}</select></label>{metric && <label className="text-xs text-zinc-500">Calculation<select aria-label="Graph calculation" className="mt-1 block h-9 rounded-md border bg-white px-2 text-sm text-zinc-800" value={aggregation} onChange={e => setAggregation(e.target.value)}>{[['sum', 'Total'], ['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}</div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{loading && <p role="status" className="text-xs text-zinc-500">Generating graph…</p>}
    {data && !loading && <><p className="text-xs text-zinc-500">{data.scope}{data.hasMore ? ' · Additional groups are not displayed.' : ''}</p><div className="overflow-x-auto"><div style={{ minWidth: Math.max(400, data.rows.length * 85), height: 300 }}><ResponsiveContainer width="100%" height="100%"><BarChart data={data.rows}><CartesianGrid vertical={false}/><XAxis dataKey="category" tick={{ fontSize: 11 }} interval={0} tickFormatter={value => String(value).length > 12 ? `${String(value).slice(0, 9)}...` : String(value)}/><YAxis width={65}/><Tooltip/><Bar name={metric || 'Record count'} dataKey="value" fill="#be185d"/></BarChart></ResponsiveContainer></div></div></>}
  </div>;
}
