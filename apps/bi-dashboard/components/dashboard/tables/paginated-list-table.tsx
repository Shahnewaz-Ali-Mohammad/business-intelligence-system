'use client';

// Server-paginated table for row-level list reports (ticket_list /
// customer_list). Every page is re-queried from the database with the SAME
// filters the report was built from (data.ticketListFilters /
// data.customerListFilters) via /api/lists/[kind] -- so the user can browse
// every single row, not a capped slice. Columns are formatted by the same
// getReportTable() used everywhere else, so headers/requestedMetrics stay
// identical to the rest of the app.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DashboardData } from '@/lib/dashboard/metrics';
import { getReportTable } from '@/lib/dashboard/report-table';

export type ListTopic = 'ticket_list' | 'customer_list' | 'top_customers' | 'semantic_query';

type Params = Record<string, string | number | null | undefined>;

// 2026-10-04: one config per report type that can be larger than what is
// stored inline. Every one of them pages from the database and exports in
// full -- same behavior for all, no special cases elsewhere.
const PAGED: Record<ListTopic, {
  api: string;
  exportPath: string;
  params: (d: DashboardData) => Params | undefined;
  total: (d: DashboardData) => number | undefined;
}> = {
  ticket_list: {
    api: 'tickets',
    exportPath: '/api/exports/tickets',
    params: (d) => d.ticketListFilters,
    total: (d) => d.ticketListTotalCount,
  },
  customer_list: {
    api: 'customers',
    exportPath: '/api/exports/customer-list',
    params: (d) => d.customerListFilters,
    total: (d) => d.customerListTotalCount,
  },
  top_customers: {
    api: 'top-customers',
    exportPath: '/api/exports/report/top-customers',
    params: (d) => d.customerFinancialsQuery,
    total: (d) => d.customerFinancialsTotalCount,
  },
  semantic_query: {
    api: 'semantic',
    exportPath: '/api/exports/report/semantic',
    params: (d) =>
      d.semanticQuery
        ? { q: JSON.stringify(d.semanticQuery), maxRows: d.semanticQueryMaxRows ?? undefined }
        : undefined,
    total: (d) => d.semanticQueryTotalCount,
  },
};

/** True when this report can be paged/exported from the database. */
export function isListTopic(topic: string | null | undefined, data?: DashboardData): topic is ListTopic {
  if (!topic || !(topic in PAGED)) return false;
  return data ? Boolean(PAGED[topic as ListTopic].params(data)) : true;
}

function toQuery(params: Params | undefined): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  return sp.toString();
}

/** Full-dataset Excel export URL for a report, carrying its own query. */
export function listExportUrl(topic: ListTopic, data: DashboardData): string | null {
  const params = PAGED[topic].params(data);
  if (!params) return null;
  const q = toQuery(params);
  return q ? `${PAGED[topic].exportPath}?${q}` : PAGED[topic].exportPath;
}

export function listTotalCount(topic: ListTopic, data: DashboardData): number {
  const n = PAGED[topic].total(data);
  return typeof n === 'number' ? n : 0;
}

/** Turns one page of rows into the same table getReportTable builds. */
function pageTable(topic: ListTopic, data: DashboardData, page: { rows?: Record<string, unknown>[]; table?: { headers: string[]; rows: (string | number)[][] } }) {
  if (topic === 'semantic_query') {
    return getReportTable(topic, { ...data, semanticQueryTable: page.table ?? data.semanticQueryTable } as DashboardData);
  }
  const key = topic === 'ticket_list' ? 'ticketList' : topic === 'customer_list' ? 'customerList' : 'customerFinancials';
  return getReportTable(topic, { ...data, [key]: page.rows ?? [] } as DashboardData);
}

function inlineRows(topic: ListTopic, data: DashboardData): unknown[] {
  if (topic === 'ticket_list') return data.ticketList ?? [];
  if (topic === 'customer_list') return data.customerList ?? [];
  if (topic === 'top_customers') return data.customerFinancials ?? [];
  return data.semanticQueryTable?.rows ?? [];
}

const PAGE_SIZE = 100;

export function PaginatedListTable({ topic, data }: { topic: ListTopic; data: DashboardData }) {
  return <PaginatedListTableBody key={`${topic}:${toQuery(PAGED[topic].params(data))}`} topic={topic} data={data} />;
}

function PaginatedListTableBody({ topic, data }: { topic: ListTopic; data: DashboardData }) {
  const params = PAGED[topic].params(data);
  const queryString = toQuery(params);
  const inline = inlineRows(topic, data);
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const total = liveTotal ?? Math.max(listTotalCount(topic, data), inline.length);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstPageTable = useMemo(() => {
    const t = getReportTable(topic, data);
    return { headers: t.headers, rows: t.rows.slice(0, PAGE_SIZE) };
  }, [topic, data]);

  const [page, setPage] = useState(1);
  const [table, setTable] = useState(firstPageTable);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jump, setJump] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(null);
      }
    });
    fetch(`/api/lists/${PAGED[topic].api}?page=${page}&pageSize=${PAGE_SIZE}${queryString ? `&${queryString}` : ''}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (controller.signal.aborted) return;
        if (typeof body.totalCount === 'number' && Number.isFinite(body.totalCount)) {
          setLiveTotal(Math.max(0, body.totalCount));
          const lastPage = Math.max(1, Math.ceil(body.totalCount / PAGE_SIZE));
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
        }
        const t = pageTable(topic, data, body);
        setTable({ headers: t.headers, rows: t.rows });
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setError('Could not load this page. Try again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, topic, queryString, data]);

  const firstRow = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const lastRow = Math.min(page * PAGE_SIZE, total);
  const go = (p: number) => setPage(Math.min(pageCount, Math.max(1, p)));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Rows {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {total.toLocaleString()}
        </p>
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <button type="button" onClick={() => go(page - 1)} disabled={page <= 1 || loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 font-medium disabled:opacity-40">
            <ChevronLeft size={14} /> Prev
          </button>
          <span>Page {page.toLocaleString()} of {pageCount.toLocaleString()}</span>
          <button type="button" onClick={() => go(page + 1)} disabled={page >= pageCount || loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 font-medium disabled:opacity-40">
            Next <ChevronRight size={14} />
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jump);
              if (Number.isFinite(n) && n >= 1) go(Math.floor(n));
              setJump('');
            }}
            className="flex items-center gap-1"
          >
            <input value={jump} onChange={(e) => setJump(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Go to"
              className="h-7 w-16 rounded-md border border-zinc-200 px-2" />
          </form>
        </div>
      </div>
      {error ? <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">{error}</p> : null}
      <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              {table.headers.map((header, i) => (
                <th key={`${header}-${i}`} className="px-5 py-3 font-semibold">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="px-5 py-3 text-zinc-700">
                    {typeof cell === 'number' ? cell.toLocaleString('en-US') : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Client-side pagination for every OTHER table on the report page (the
// rows are already in the saved report, so no server round trip needed).
export function ClientPaginatedTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const first = rows.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(page * PAGE_SIZE, rows.length);
  return (
    <div>
      {rows.length > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Rows {first.toLocaleString()}–{last.toLocaleString()} of {rows.length.toLocaleString()}
          </p>
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 font-medium disabled:opacity-40">
              <ChevronLeft size={14} /> Prev
            </button>
            <span>Page {page.toLocaleString()} of {pageCount.toLocaleString()}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 font-medium disabled:opacity-40">
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              {headers.map((header, i) => (
                <th key={`${header}-${i}`} className="px-5 py-3 font-semibold">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {shown.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="px-5 py-3 text-zinc-700">
                    {typeof cell === 'number' ? cell.toLocaleString('en-US') : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
