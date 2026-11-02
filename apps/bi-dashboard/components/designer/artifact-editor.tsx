'use client';

import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import type { Block } from '@/lib/designer/spec';

export type DesignToolOption = {
  id: string;
  name: string;
  description: string;
  mode: 'rows' | 'aggregate';
  fields: { id: string; type: string; table: string }[];
};

type Filter = { field: string; operator: string; value: string };
type Metric = { field: string; operation: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max'; alias: string };
const input = 'mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100';
const numeric = (field: DesignToolOption['fields'][number]) => /(int|decimal|numeric|float|double|money|real|number|bigint|smallint)/i.test(field.type);
const date = (field: DesignToolOption['fields'][number]) => /(date|time)/i.test(field.type);
const idFor = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const safeAlias = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^\d+/, '').slice(0, 55) || 'value';
const readable = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
const fieldLabel = (field: DesignToolOption['fields'][number]) => {
  const name = field.id.split(':').at(-1) || field.id;
  const table = field.table?.split('.').at(-1) || '';
  return `${readable(name)}${table ? ` · ${readable(table)}` : ''}`;
};
const toolLabel = (tool: DesignToolOption) => {
  const tables = [...new Set(tool.fields.map((field) => field.table?.split('.').at(-1)).filter(Boolean))];
  return `${tables.map((table) => readable(table!)).join(' + ') || readable(tool.name)} · ${tool.mode === 'rows' ? 'Records' : 'Summary'}`;
};
function readQuery(block: Block | null | undefined) {
  try { return block?.query ? JSON.parse(block.query) as Record<string, unknown> : {}; } catch { return {}; }
}
function queryColumns(block: Block | null | undefined) { const columns = readQuery(block).columns; return Array.isArray(columns) ? columns.filter((value): value is string => typeof value === 'string') : []; }
function queryGroup(block: Block | null | undefined) {
  const query = readQuery(block);
  const groups = Array.isArray(query.groupBy) ? query.groupBy : [];
  const dates = Array.isArray(query.dateGroups) ? query.dateGroups : [];
  return typeof groups[0] === 'string' ? groups[0] : typeof (dates[0] as { field?: unknown } | undefined)?.field === 'string' ? (dates[0] as { field: string }).field : '';
}
function queryMetrics(block: Block | null | undefined): Metric[] {
  const metrics = readQuery(block).metrics;
  return Array.isArray(metrics) ? metrics.filter((metric): metric is Metric => Boolean(metric && typeof metric === 'object' && 'operation' in metric && 'alias' in metric)).map((metric) => ({ field: typeof metric.field === 'string' ? metric.field : '', operation: metric.operation, alias: metric.alias })) : [];
}
function queryFilters(block: Block | null | undefined): Filter[] {
  const where = readQuery(block).where;
  const clauses = where && typeof where === 'object' && 'and' in where && Array.isArray((where as { and: unknown }).and) ? (where as { and: unknown[] }).and : where ? [where] : [];
  return clauses.flatMap((item) => item && typeof item === 'object' && 'field' in item ? [{ field: String((item as { field: unknown }).field), operator: String((item as { operator?: unknown }).operator || 'eq'), value: String((item as { value?: unknown }).value ?? '') }] : []);
}
function querySort(block: Block | null | undefined) {
  const sorts = readQuery(block).sort;
  const sort = Array.isArray(sorts) ? sorts[0] as { field?: unknown; direction?: unknown } | undefined : undefined;
  return { field: typeof sort?.field === 'string' ? sort.field : '', direction: sort?.direction === 'desc' ? 'desc' as const : 'asc' as const };
}

export function ArtifactEditor({
  block,
  initialBlock,
  availableBlocks,
  tools,
  loadingTools,
  onClose,
  onSave,
  saving,
}: {
  block: Block | null;
  initialBlock: Block;
  availableBlocks: Block[];
  tools: DesignToolOption[];
  loadingTools: boolean;
  onClose: () => void;
  onSave: (block: Block, previousId?: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<Block>(block || initialBlock);
  const [toolId, setToolId] = useState(block?.toolId || initialBlock.toolId || '');
  const [selectedColumns, setSelectedColumns] = useState<string[]>(() => queryColumns(block || initialBlock));
  const [groupField, setGroupField] = useState(() => queryGroup(block || initialBlock));
  const [grain, setGrain] = useState(() => { const dates = readQuery(block || initialBlock).dateGroups; return Array.isArray(dates) && typeof (dates[0] as { grain?: unknown } | undefined)?.grain === 'string' ? (dates[0] as { grain: string }).grain : ''; });
  const [metrics, setMetrics] = useState<Metric[]>(() => queryMetrics(block || initialBlock));
  const [filters, setFilters] = useState<Filter[]>(() => queryFilters(block || initialBlock));
  const [sortField, setSortField] = useState(() => querySort(block || initialBlock).field);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => querySort(block || initialBlock).direction);
  const [limit, setLimit] = useState(() => { const query = readQuery(block || initialBlock); return typeof query.limit === 'number' ? query.limit : (block || initialBlock).type === 'table' ? 200 : 30; });
  const [formError, setFormError] = useState('');

  const compatibleTools = useMemo(() => tools.filter((tool) => draft.type === 'table' ? tool.mode === 'rows' : tool.mode === 'aggregate'), [draft.type, tools]);
  const currentTool = useMemo(() => tools.find((tool) => tool.id === toolId) || compatibleTools[0] || null, [compatibleTools, tools, toolId]);
  const numericFields = useMemo(() => currentTool?.fields.filter(numeric) || [], [currentTool]);
  const groupFields = useMemo(() => currentTool?.fields || [], [currentTool]);
  const defaultGroupField = groupFields.find((field) => !date(field))?.id || groupFields[0]?.id || '';
  const effectiveGroupField = groupField || defaultGroupField;
  const effectiveColumns = selectedColumns.length ? selectedColumns : currentTool?.fields.slice(0, 8).map((field) => field.id) || [];
  const defaultMetricField = numericFields[0]?.id || '';
  const displayedMetrics = metrics.length ? metrics : [{ field: defaultMetricField, operation: defaultMetricField ? 'sum' as const : 'count' as const, alias: defaultMetricField ? safeAlias(defaultMetricField.split(':').at(-1) || 'total') : 'record_count' }];
  const patch = (value: Partial<Block>) => setDraft((current) => current ? { ...current, ...value } : current);
  const isDataType = isData(draft.type);

  function toggleColumn(id: string) {
    setSelectedColumns((current) => {
      const selected = current.length ? current : effectiveColumns;
      return selected.includes(id) ? selected.filter((field) => field !== id) : selected.length < 20 ? [...selected, id] : selected;
    });
  }
  function updateMetric(index: number, change: Partial<Metric>) {
    setMetrics((current) => (current.length ? current : displayedMetrics).map((metric, i) => i === index ? { ...metric, ...change } : metric));
  }
  function save() {
    setFormError('');
    if (!draft.title.trim()) { setFormError('Give this block a title.'); return; }
    let next: Block = { ...draft, title: draft.title.trim() };
    if (isDataType) {
      if (!currentTool) { setFormError(`No approved ${draft.type === 'table' ? 'row' : 'summary'} tool is available in this workspace.`); return; }
      const where = filters.filter((filter) => filter.field && (filter.operator === 'is_null' || filter.operator === 'not_null' || filter.value.trim())).map((filter) => ({ field: filter.field, operator: filter.operator, ...(filter.operator === 'is_null' || filter.operator === 'not_null' ? {} : { value: filter.operator === 'in' ? filter.value.split(',').map((value) => value.trim()).filter(Boolean) : filter.operator === 'between' ? filter.value.split(',').map((value) => value.trim()) : filter.value }) }));
      if (filters.some((filter) => !filter.field || (filter.operator === 'between' && filter.value.split(',').filter((value) => value.trim()).length !== 2) || (filter.operator === 'in' && !filter.value.split(',').some((value) => value.trim())))) { setFormError('Complete each filter. “Between” needs two comma-separated values.'); return; }
      const query: Record<string, unknown> = { limit: Math.max(1, Math.min(draft.type === 'table' ? 200 : 60, limit)) };
      if (where.length === 1) query.where = where[0]; else if (where.length > 1) query.where = { and: where };
      if (draft.type === 'table') {
        if (!effectiveColumns.length) { setFormError('Select at least one table column.'); return; }
        query.columns = effectiveColumns;
          if (sortField) query.sort = [{ field: sortField, direction: sortDirection }];
      } else {
        const validMetrics = displayedMetrics.filter((metric) => metric.operation === 'count' || metric.operation === 'count_distinct' || metric.field).map((metric) => ({ ...metric, field: metric.field || null, alias: safeAlias(metric.alias) }));
        if (!validMetrics.length) { setFormError('Add at least one valid metric.'); return; }
        query.metrics = draft.type === 'kpi' ? validMetrics.slice(0, 1) : validMetrics.slice(0, 3);
        if (draft.type === 'chart') {
          if (!effectiveGroupField) { setFormError('Choose a category or date field for the chart.'); return; }
          if (grain) query.dateGroups = [{ field: effectiveGroupField, grain }]; else query.groupBy = [effectiveGroupField];
          query.sort = [{ field: sortField || effectiveGroupField, direction: sortDirection }];
        } else {
          query.metrics = validMetrics.slice(0, 1);
        }
      }
      next = { ...next, toolId: currentTool.id, query: JSON.stringify(query) };
    } else if (draft.type === 'insight') {
      if (!draft.sourceBlockId) { setFormError('Select a chart or table for this insight.'); return; }
    }
    onSave(next, block?.id);
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-zinc-950/30 print:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-labelledby="artifact-editor-title" className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-zinc-200 px-5 py-4">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Report artifact</p><h2 id="artifact-editor-title" className="mt-1 text-lg font-semibold">{block ? 'Edit block' : `Add ${draft.type}`}</h2><p className="mt-1 text-sm text-zinc-500">Changes are saved to this report and appear in its version history.</p></div>
          <button type="button" onClick={onClose} aria-label="Close editor" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <label className="text-sm font-medium">Block title<input className={input} maxLength={200} value={draft.title} onChange={(event) => patch({ title: event.target.value })} /></label>
            <label className="text-sm font-medium">Width<select className={input} value={draft.width} onChange={(event) => patch({ width: event.target.value as Block['width'] })}><option value="full">Full</option><option value="half">Half</option><option value="third">Third</option></select></label>
          </div>

          {(draft.type === 'heading' || draft.type === 'text') && <label className="block text-sm font-medium">{draft.type === 'heading' ? 'Heading text' : 'Report text'}<textarea className={`${input} min-h-36 resize-y`} maxLength={4000} value={draft.text || ''} onChange={(event) => patch({ text: event.target.value })} placeholder={draft.type === 'heading' ? 'Section heading' : 'Add context, notes, or methodology'} /></label>}

          {draft.type === 'insight' && <label className="block text-sm font-medium">Base this insight on<select className={input} value={draft.sourceBlockId || ''} onChange={(event) => patch({ sourceBlockId: event.target.value || null, text: null })}><option value="">Choose a chart or table</option>{availableBlocks.filter((candidate) => candidate.id !== draft.id && (candidate.type === 'chart' || candidate.type === 'table' || candidate.type === 'kpi')).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title || candidate.type}</option>)}</select><span className="mt-1 block text-xs font-normal text-zinc-500">The insight is recalculated from the selected block&apos;s returned data.</span></label>}

          {isDataType && <>
            {loadingTools ? <div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-4 text-sm text-zinc-500"><Loader2 size={16} className="animate-spin" />Loading approved data fields…</div> : <>
              <label className="block text-sm font-medium">Approved data tool<select className={input} value={toolId || currentTool?.id || ''} onChange={(event) => { setToolId(event.target.value); const chosen = compatibleTools.find((tool) => tool.id === event.target.value); if (chosen) { setSelectedColumns(chosen.fields.slice(0, 8).map((field) => field.id)); setGroupField(chosen.fields.find((field) => !date(field))?.id || chosen.fields[0]?.id || ''); setMetrics([{ field: chosen.fields.find(numeric)?.id || '', operation: chosen.fields.some(numeric) ? 'sum' : 'count', alias: chosen.fields.some(numeric) ? 'total' : 'record_count' }]); } }}><option value="">Choose approved tool</option>{compatibleTools.map((tool) => <option key={tool.id} value={tool.id}>{toolLabel(tool)}</option>)}</select>{!compatibleTools.length && <span className="mt-1 block text-xs font-normal text-amber-700">No approved {draft.type === 'table' ? 'row' : 'aggregate'} tool is available. Approve one in Settings first.</span>}</label>
              {currentTool && <p className="-mt-3 text-xs text-zinc-500">{currentTool.description}</p>}

              {draft.type === 'table' && currentTool && <>
                <FieldPicker title="Columns to show" fields={currentTool.fields} selected={effectiveColumns} onToggle={toggleColumn} />
                <SortAndLimit fields={currentTool.fields} sortField={sortField} setSortField={setSortField} sortDirection={sortDirection} setSortDirection={setSortDirection} limit={limit} setLimit={setLimit} max={200} />
              </>}

              {draft.type === 'chart' && currentTool && <>
                <label className="block text-sm font-medium">Group the chart by<select className={input} value={effectiveGroupField} onChange={(event) => { setGroupField(event.target.value); setGrain(''); }}><option value="">Choose a category or date</option>{groupFields.map((field) => <option key={field.id} value={field.id}>{fieldLabel(field)} · {field.type}</option>)}</select></label>
                {effectiveGroupField && date(currentTool.fields.find((field) => field.id === effectiveGroupField)!) && <label className="block text-sm font-medium">Date interval<select className={input} value={grain} onChange={(event) => setGrain(event.target.value)}><option value="">Exact date</option><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></label>}
                <MetricEditor metrics={displayedMetrics} fields={currentTool.fields} onChange={updateMetric} onAdd={() => setMetrics((current) => current.length < 3 ? [...(current.length ? current : displayedMetrics), { field: numericFields[0]?.id || '', operation: 'sum', alias: `metric_${current.length + 1}` }] : current)} onRemove={(i) => setMetrics((current) => current.filter((_, index) => index !== i))} />
                <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm font-medium">Sort groups by<select className={input} value={sortField || effectiveGroupField} onChange={(event) => setSortField(event.target.value)}><option value={effectiveGroupField}>Category</option>{displayedMetrics.map((metric) => <option key={metric.alias} value={safeAlias(metric.alias)}>{metric.alias || 'Metric'}</option>)}</select></label><label className="text-sm font-medium">Direction<select className={input} value={sortDirection} onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><label className="text-sm font-medium">Maximum groups<input className={input} type="number" min={1} max={60} value={limit} onChange={(event) => setLimit(Math.max(1, Math.min(60, Number(event.target.value) || 1)))} /></label></div>
                <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Chart type<select className={input} value={draft.chartKind || 'bar'} onChange={(event) => patch({ chartKind: event.target.value as Block['chartKind'] })}><option value="bar">Vertical bars</option><option value="hbar">Horizontal bars</option><option value="line">Line</option><option value="area">Area</option><option value="pie">Pie</option><option value="stacked">Stacked bars</option></select></label><label className="text-sm font-medium">Number format<select className={input} value={draft.format || 'number'} onChange={(event) => patch({ format: event.target.value as Block['format'] })}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option></select></label></div>
              </>}

              {draft.type === 'kpi' && currentTool && <>
                <MetricEditor metrics={displayedMetrics.slice(0, 1)} fields={currentTool.fields} onChange={(index, change) => { const base = metrics.length ? metrics : displayedMetrics; setMetrics(base.map((metric, i) => i === index ? { ...metric, ...change } : metric)); }} onAdd={() => undefined} onRemove={() => undefined} allowMultiple={false} />
                <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Number format<select className={input} value={draft.format || 'number'} onChange={(event) => patch({ format: event.target.value as Block['format'] })}><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option></select></label><label className="text-sm font-medium">Limit<input className={input} type="number" min={1} max={1} value={1} readOnly /></label></div>
              </>}

              {currentTool && <FilterEditor filters={filters} fields={currentTool.fields} onChange={setFilters} />}
            </>}
          </>}
          {formError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{formError}</p>}
        </div>
        <footer className="flex items-center justify-between border-t border-zinc-200 p-4"><span className="text-xs text-zinc-400">Up to 40 blocks per report</span><div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium">Cancel</button><button type="button" onClick={save} disabled={saving || (isDataType && loadingTools)} className="inline-flex items-center gap-2 rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50">{saving ? <Loader2 size={15} className="animate-spin" /> : block ? null : <Plus size={15} />}{block ? 'Save changes' : 'Add to report'}</button></div></footer>
      </aside>
    </div>
  );
}

function isData(type: Block['type']) { return type === 'kpi' || type === 'chart' || type === 'table'; }

function FieldPicker({ title, fields, selected, onToggle }: { title: string; fields: DesignToolOption['fields']; selected: string[]; onToggle: (id: string) => void }) {
  return <fieldset className="rounded-xl border border-zinc-200 p-3"><legend className="px-1 text-sm font-semibold">{title} <span className="font-normal text-zinc-400">({selected.length}/20)</span></legend><div className="max-h-56 space-y-1 overflow-y-auto">{fields.map((field) => <label key={field.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50"><input type="checkbox" checked={selected.includes(field.id)} onChange={() => onToggle(field.id)} disabled={!selected.includes(field.id) && selected.length >= 20} className="mt-0.5 accent-rose-700" /><span className="min-w-0"><span className="block">{fieldLabel(field)}</span><span className="text-xs text-zinc-400">{field.type}</span></span></label>)}</div></fieldset>;
}

function MetricEditor({ metrics, fields, onChange, onAdd, onRemove, allowMultiple = true }: { metrics: Metric[]; fields: DesignToolOption['fields']; onChange: (index: number, change: Partial<Metric>) => void; onAdd: () => void; onRemove: (index: number) => void; allowMultiple?: boolean }) {
  return <fieldset className="space-y-3 rounded-xl border border-zinc-200 p-3"><legend className="px-1 text-sm font-semibold">Metric{allowMultiple ? 's' : ''}</legend>{metrics.map((metric, index) => <div key={index} className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-medium text-zinc-500">Field<select className={input} value={metric.field} onChange={(event) => onChange(index, { field: event.target.value })}><option value="">All records</option>{fields.map((field) => <option key={field.id} value={field.id} disabled={!['count', 'count_distinct'].includes(metric.operation) && !numeric(field)}>{fieldLabel(field)}</option>)}</select></label><label className="text-xs font-medium text-zinc-500">Calculation<select className={input} value={metric.operation} onChange={(event) => onChange(index, { operation: event.target.value as Metric['operation'] })}><option value="count">Count</option><option value="count_distinct">Distinct count</option><option value="sum" disabled={!metric.field || !fields.some((field) => field.id === metric.field && numeric(field))}>Sum</option><option value="avg" disabled={!metric.field || !fields.some((field) => field.id === metric.field && numeric(field))}>Average</option><option value="min" disabled={!metric.field || !fields.some((field) => field.id === metric.field && numeric(field))}>Minimum</option><option value="max" disabled={!metric.field || !fields.some((field) => field.id === metric.field && numeric(field))}>Maximum</option></select></label><label className="text-xs font-medium text-zinc-500">Output name<input className={input} value={metric.alias} maxLength={63} onChange={(event) => onChange(index, { alias: event.target.value })} /></label>{allowMultiple && <button type="button" onClick={() => onRemove(index)} aria-label="Remove metric" className="mt-5 rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={16} /></button>}</div>)}{allowMultiple && metrics.length < 3 && <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"><Plus size={13} />Add metric</button>}</fieldset>;
}

function FilterEditor({ filters, fields, onChange }: { filters: Filter[]; fields: DesignToolOption['fields']; onChange: (filters: Filter[]) => void }) {
  const operators = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'between', 'is_null', 'not_null'];
  return <fieldset className="space-y-3 rounded-xl border border-zinc-200 p-3"><legend className="px-1 text-sm font-semibold">Filters</legend>{filters.map((filter, index) => <div key={index} className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-medium text-zinc-500">Field<select className={input} value={filter.field} onChange={(event) => onChange(filters.map((f, i) => i === index ? { ...f, field: event.target.value } : f))}><option value="">Choose field</option>{fields.map((field) => <option key={field.id} value={field.id}>{fieldLabel(field)}</option>)}</select></label><label className="text-xs font-medium text-zinc-500">Condition<select className={input} value={filter.operator} onChange={(event) => onChange(filters.map((f, i) => i === index ? { ...f, operator: event.target.value } : f))}>{operators.map((operator) => <option key={operator} value={operator}>{operator.replace('_', ' ')}</option>)}</select></label><label className="text-xs font-medium text-zinc-500">Value<input className={input} value={filter.value} disabled={['is_null', 'not_null'].includes(filter.operator)} placeholder={filter.operator === 'in' || filter.operator === 'between' ? 'Separate values with commas' : 'Value'} onChange={(event) => onChange(filters.map((f, i) => i === index ? { ...f, value: event.target.value } : f))} /></label><button type="button" onClick={() => onChange(filters.filter((_, i) => i !== index))} aria-label="Remove filter" className="mt-5 rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={16} /></button></div>)}<button type="button" onClick={() => onChange([...filters, { field: '', operator: 'eq', value: '' }])} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"><Plus size={13} />Add filter</button><p className="text-xs text-zinc-400">Multiple filters are combined with AND.</p></fieldset>;
}

function SortAndLimit({ fields, sortField, setSortField, sortDirection, setSortDirection, limit, setLimit, max, allowFieldChange = true }: { fields: DesignToolOption['fields']; sortField: string; setSortField: (field: string) => void; sortDirection: 'asc' | 'desc'; setSortDirection: (direction: 'asc' | 'desc') => void; limit: number; setLimit: (limit: number) => void; max: number; allowFieldChange?: boolean }) {
  return <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm font-medium">Sort by<select className={input} disabled={!allowFieldChange} value={sortField} onChange={(event) => setSortField(event.target.value)}><option value="">Default order</option>{fields.map((field) => <option key={field.id} value={field.id}>{fieldLabel(field)}</option>)}</select></label><label className="text-sm font-medium">Direction<select className={input} value={sortDirection} onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><label className="text-sm font-medium">Maximum results<input className={input} type="number" min={1} max={max} value={limit} onChange={(event) => setLimit(Math.max(1, Math.min(max, Number(event.target.value) || 1)))} /></label></div>;
}

export function newArtifact(type: Block['type']): Block {
  const defaultTitle: Record<Block['type'], string> = { heading: 'Section heading', text: 'Note', insight: 'Key insight', kpi: 'New KPI', chart: 'New chart', table: 'New table' };
  return { id: idFor(), type, title: defaultTitle[type], width: type === 'table' || type === 'heading' || type === 'text' || type === 'insight' ? 'full' : 'third', toolId: null, query: null, chartKind: type === 'chart' ? 'bar' : null, format: type === 'kpi' || type === 'chart' ? 'number' : null, text: type === 'text' || type === 'heading' ? '' : null, sourceBlockId: null };
}
