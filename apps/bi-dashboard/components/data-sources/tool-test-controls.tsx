"use client";

import { useState } from "react";
import { Plus, Trash2, Play } from "lucide-react";
import type { Catalog, ToolDefinition } from "@/lib/tool-setup/store";

const input = "h-10 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-100";
const button = "inline-flex items-center justify-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40";
type Filter = { field: string; operator: ToolDefinition["filters"][number]["operator"]; value: string };
const operators = { eq: "Equals", ne: "Does not equal", gt: "Greater than", gte: "At least", lt: "Less than", lte: "At most", contains: "Contains", is_null: "Is empty", not_null: "Is not empty" };

export function ToolTestControls({ definition, catalog, busy, onRun }: {
  definition: ToolDefinition; catalog: Catalog; busy: boolean;
  onRun: (parameters: Record<string, string>) => void;
}) {
  const fields = (definition.capabilities?.fields || []).filter((id) => catalog.objects.some((o) => o.columns.some((c) => `${o.id}:${c.name}` === id && !c.restricted)));
  const label = (id: string) => {
    const object = catalog.objects.find((o) => id.startsWith(`${o.id}:`));
    return object ? `${object.name} · ${id.slice(object.id.length + 1)}` : id;
  };
  const [columns, setColumns] = useState(definition.columns);
  const [groups, setGroups] = useState(definition.groupBy);
  const [metrics, setMetrics] = useState(definition.metrics);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [joins, setJoins] = useState(definition.joins);
  const [error, setError] = useState("");
  const numericFields = fields.filter((id) => catalog.objects.some((o) => o.columns.some((c) => `${o.id}:${c.name}` === id && /^(tinyint|smallint|int|integer|bigint|decimal|numeric|real|float|double|money|smallmoney)\b/i.test(c.dataType))));
  const fieldSelect = (value: string, change: (value: string) => void, count = false, numeric = false) => <select aria-label="Column" className={input} value={value} onChange={(e) => change(e.target.value)}>{count && <option value="">All records</option>}{numeric && <option value="">Select numeric column</option>}{(numeric ? numericFields : fields).map((f) => <option key={f} value={f}>{label(f)}</option>)}</select>;
  function run() {
    setError("");
    if (definition.mode === "rows" && !columns.length) return setError("Select at least one column.");
    if (definition.mode === "aggregate" && !metrics.length) return setError("Add at least one calculation.");
    if (metrics.some((m) => ["sum", "avg"].includes(m.operation) && !numericFields.includes(m.field || ""))) return setError("Choose a numeric column for totals and averages.");
    const used = [...columns, ...groups, ...metrics.map((m) => m.field).filter((f): f is string => !!f), ...filters.map((f) => f.field)];
    const connected = new Set([definition.base]);
    for (const join of joins) {
      const relation = catalog.relationships.find((r) => r.id === join);
      if (!relation || !connected.has(relation.from)) return setError("Select related tables in connection order.");
      connected.add(relation.to);
    }
    if (used.some((f) => !Array.from(connected).some((id) => f.startsWith(`${id}:`)))) return setError("Select the related table for the columns you chose.");
    if (filters.some((f) => !["is_null", "not_null"].includes(f.operator) && !f.value.trim())) return setError("Enter a value for every filter.");
    onRun({ query: JSON.stringify({ columns: definition.mode === "rows" ? columns : [], groupBy: definition.mode === "aggregate" ? groups : [], metrics: definition.mode === "aggregate" ? metrics : [], joins, filters: filters.map((f, i) => ({ field: f.field, operator: f.operator, parameter: `filter_${i}`, required: true })), values: Object.fromEntries(filters.filter((f) => !["is_null", "not_null"].includes(f.operator)).map((f) => [`filter_${filters.indexOf(f)}`, f.value])) }) });
  }
  return <fieldset disabled={busy} className="min-w-0 space-y-5">
    <div><h4 className="mb-2 text-sm font-medium">{definition.mode === "rows" ? "Columns" : "Group by"}</h4><div className="grid max-h-56 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">{fields.map((f) => {
      const selected = definition.mode === "rows" ? columns : groups;
      return <label key={f} className="flex items-start gap-2 break-words text-sm"><input type="checkbox" className="mt-1 accent-rose-700" checked={selected.includes(f)} onChange={(e) => {
        const next = e.target.checked ? [...selected, f] : selected.filter((v) => v !== f);
        if (next.length > (definition.mode === "rows" ? 30 : 5)) { setError(definition.mode === "rows" ? "Select up to 30 columns." : "Select up to 5 grouping columns."); return; }
        setError(""); (definition.mode === "rows" ? setColumns : setGroups)(next);
      }} />{label(f)}</label>;
    })}</div></div>
    {definition.mode === "aggregate" && <div className="space-y-2"><h4 className="text-sm font-medium">Calculations</h4>{metrics.map((m, i) => <div key={i} className="grid items-center gap-2 sm:grid-cols-[1fr_2fr_auto]">
      <select aria-label="Calculation" className={input} value={m.operation} onChange={(e) => setMetrics(metrics.map((v, n) => n === i ? { ...v, operation: e.target.value as typeof m.operation, field: e.target.value === "count" ? v.field : v.field || fields[0] } : v))}>{Object.entries({ count: "Count", sum: "Total", avg: "Average", min: "Minimum", max: "Maximum" }).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      {fieldSelect(m.field || "", (field) => setMetrics(metrics.map((v, n) => n === i ? { ...v, field: field || null } : v)), m.operation === "count", ["sum", "avg"].includes(m.operation))}
      <button type="button" title="Remove calculation" className={button} onClick={() => setMetrics(metrics.filter((_, n) => n !== i))}><Trash2 size={16} /></button>
    </div>)}<button type="button" disabled={metrics.length >= 8} className={button} onClick={() => setMetrics([...metrics, { field: null, operation: "count", alias: `metric_${Date.now()}_${metrics.length}` }])}><Plus size={16} />Add calculation</button></div>}
    {!!definition.capabilities?.joins.length && <div className="space-y-2"><h4 className="text-sm font-medium">Related tables</h4>{definition.capabilities.joins.map((id) => {
      const relation = catalog.relationships.find((r) => r.id === id);
      return <label key={id} className="flex gap-2 text-sm"><input type="checkbox" className="accent-rose-700" checked={joins.includes(id)} onChange={(e) => setJoins(e.target.checked ? [...joins, id] : joins.filter((j) => j !== id))} />{relation ? `${catalog.objects.find((o) => o.id === relation.from)?.name} → ${catalog.objects.find((o) => o.id === relation.to)?.name}` : id}</label>;
    })}</div>}
    <div className="space-y-2"><h4 className="text-sm font-medium">Filters</h4>{filters.map((f, i) => <div key={i} className="grid items-center gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
      {fieldSelect(f.field, (field) => setFilters(filters.map((v, n) => n === i ? { ...v, field } : v)))}
      <select aria-label="Filter condition" className={input} value={f.operator} onChange={(e) => setFilters(filters.map((v, n) => n === i ? { ...v, operator: e.target.value as Filter["operator"] } : v))}>{Object.entries(operators).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input aria-label="Filter value" className={input} disabled={["is_null", "not_null"].includes(f.operator)} value={f.value} onChange={(e) => setFilters(filters.map((v, n) => n === i ? { ...v, value: e.target.value } : v))} />
      <button type="button" title="Remove filter" className={button} onClick={() => setFilters(filters.filter((_, n) => n !== i))}><Trash2 size={16} /></button>
    </div>)}<button type="button" disabled={!fields.length || filters.length >= 12} className={button} onClick={() => setFilters([...filters, { field: fields[0], operator: "eq", value: "" }])}><Plus size={16} />Add filter</button></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button type="button" className="inline-flex items-center gap-2 rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" onClick={run}><Play size={16} />{busy ? "Testing..." : "Run read-only test"}</button>
  </fieldset>;
}
