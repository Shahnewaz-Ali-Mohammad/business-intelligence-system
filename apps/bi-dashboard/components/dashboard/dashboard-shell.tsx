'use client';

import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowUpRight,
  CalendarDays,
  Database,
  Download,
  FileText,
  Home,
  LayoutDashboard,
  MessageSquareText,
  MoreHorizontal,
  Pin,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Snowflake,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Kpi, TopCustomerByOrders } from '@/lib/dashboard/types';
import type { ChatResponse, DashboardData } from '@/lib/dashboard/metrics';

function StatusBadge({ status }: { status: 'Live' | 'Snapshot' | 'Freeze' }) {
  const styles = {
    Live: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    Snapshot: 'border-blue-200 bg-blue-50 text-blue-700',
    Freeze: 'border-amber-200 bg-amber-50 text-amber-700',
  };

  return (
    <Badge variant="outline" className={`h-6 gap-1.5 rounded-md px-2.5 font-medium shadow-sm ${styles[status]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </Badge>
  );
}

function Sidebar({
  pinnedViews,
  onSelectPinned,
  onUnpin,
  filterHistory,
  onExportTopProducts,
  onExportRepeatCustomers,
  onExportRegionBreakdown,
}: {
  pinnedViews: PinnedView[];
  onSelectPinned: (view: PinnedView) => void;
  onUnpin: (view: PinnedView) => void;
  filterHistory: FilterHistoryEntry[];
  onExportTopProducts: () => void;
  onExportRepeatCustomers: () => void;
  onExportRegionBreakdown: () => void;
}) {
  return (
    <aside className="hidden h-screen w-[280px] shrink-0 overflow-y-auto border-r border-slate-200/80 bg-white/95 shadow-[8px_0_30px_rgb(15_23_42/4%)] lg:block">
      <div className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/95 px-5 backdrop-blur">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white shadow-lg shadow-slate-950/15">
          <LayoutDashboard size={19} />
        </div>
        <div>
          <p className="text-sm font-bold text-slate-950">Business Intelligence</p>
          <p className="text-xs text-slate-500">Read-only analytics</p>
        </div>
      </div>

      <div className="space-y-6 px-3.5 py-5">
        <button className="flex w-full items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 text-left text-sm font-semibold text-blue-700 shadow-sm">
          <Home size={17} />
          Home Dashboard
          <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />
        </button>

        <nav className="space-y-2">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Pinned Pages</p>
            <Pin size={14} className="text-slate-400" />
          </div>
          {pinnedViews.length === 0 ? (
            <p className="px-3 text-xs text-slate-400">
              Use the Pin button above to save a filtered view here.
            </p>
          ) : null}
          {pinnedViews.map((view) => (
            <div
              key={`${view.title}-${view.days}-${view.region}`}
              className="group flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            >
              <button
                onClick={() => onSelectPinned(view)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <FileText size={15} className="shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate">{view.title}</span>
              </button>
              <StatusBadge status={view.status} />
              <button
                onClick={() => onUnpin(view)}
                className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-200 hover:text-slate-600 group-hover:opacity-100"
                aria-label={`Unpin ${view.title}`}
                title="Unpin"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </nav>

        <nav className="space-y-2 border-t border-slate-200 pt-5">
          <p className="px-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Filter History (this session)
          </p>
          {filterHistory.length === 0 ? (
            <p className="px-3 text-xs text-slate-400">
              Changing the date range or region filter above will log it here.
            </p>
          ) : null}
          {filterHistory.map((entry, index) => (
            <div
              key={`${entry.label}-${entry.timestamp}-${index}`}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700"
            >
              <FileText size={15} className="text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.label}</span>
                <span className="block text-xs text-slate-400">{entry.timeLabel}</span>
              </span>
            </div>
          ))}
        </nav>

        <nav className="space-y-2 border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Quick Exports</p>
            <Download size={14} className="text-slate-400" />
          </div>
          <button
            onClick={onExportTopProducts}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
          >
            <Download size={15} className="text-slate-400" />
            <span className="min-w-0 flex-1 truncate">Top Products (CSV)</span>
          </button>
          <button
            onClick={onExportRepeatCustomers}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
          >
            <Download size={15} className="text-slate-400" />
            <span className="min-w-0 flex-1 truncate">Repeat Customers (CSV)</span>
          </button>
          <button
            onClick={onExportRegionBreakdown}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
          >
            <Download size={15} className="text-slate-400" />
            <span className="min-w-0 flex-1 truncate">Region Breakdown (CSV)</span>
          </button>
        </nav>

        <div className="border-t border-slate-200 pt-5">
          <button className="flex w-full items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2.5 text-left text-sm font-medium text-slate-700">
            <Database size={16} className="text-slate-500" />
            ecommerce
            <ShieldCheck size={15} className="ml-auto text-emerald-600" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function KpiCard({
  kpi,
  topCustomers,
}: {
  kpi: Kpi;
  topCustomers?: TopCustomerByOrders[];
}) {
  const isCustomerMixCard = kpi.label === 'Active Customers';
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const chartWidth = 280;
  const chartHeight = 118;
  const plot = { left: 34, right: 12, top: 14, bottom: 28 };
  const plotWidth = chartWidth - plot.left - plot.right;
  const plotHeight = chartHeight - plot.top - plot.bottom;
  const sourcePoints =
    kpi.chartPoints?.length > 0
      ? kpi.chartPoints
      : kpi.sparkline.map((value, index) => ({
          label: `${kpi.axis.xStart} - ${kpi.axis.xEnd}`,
          value: kpi.value,
          normalized: value,
        }));
  const chartPoints = sourcePoints.map((point, index) => {
    const x =
      plot.left +
      (sourcePoints.length <= 1
        ? plotWidth / 2
        : (index / (sourcePoints.length - 1)) * plotWidth);
    const y = plot.top + (1 - point.normalized / 100) * plotHeight;

    return { ...point, x, y };
  });
  const points = chartPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const activePoint =
    activePointIndex === null ? null : chartPoints[activePointIndex] ?? null;
  const tooltipLeft = activePoint ? `${(activePoint.x / chartWidth) * 100}%` : '50%';
  const tooltipTop = activePoint
    ? `${Math.max(4, ((activePoint.y - 56) / chartHeight) * 100)}%`
    : '0%';

  return (
    <section className="flex min-h-[390px] flex-col rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgb(15_23_42/10%)]">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-600">{kpi.label}</p>
          <p className="mt-2 text-4xl font-bold tracking-tight text-slate-950">
            {kpi.value}
          </p>
        </div>
        <MoreHorizontal size={18} className="text-slate-400" />
      </div>
      <p
        className={`mb-2 flex items-center gap-1 text-sm ${
          kpi.trend === 'up' ? 'text-emerald-600' : 'text-red-600'
        }`}
      >
        <ArrowUpRight size={15} className={kpi.trend === 'down' ? 'rotate-90' : ''} />
        {kpi.delta}
      </p>
      <p className="text-sm font-medium text-slate-700">{kpi.detail}</p>
      <p className="mt-1 text-xs text-slate-500">{kpi.context}</p>
      {isCustomerMixCard ? (
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3">
          {topCustomers && topCustomers.length > 0 ? (
            <>
              <p className="mb-2 text-xs font-medium text-slate-500">
                Top {topCustomers.length} customers by orders placed
              </p>
              <ul className="space-y-1.5">
                {(() => {
                  const max = Math.max(...topCustomers.map((c) => c.orders), 1);
                  return topCustomers.map((customer, index) => (
                    <li key={`${customer.name}-${index}`} className="flex items-center gap-2 text-xs">
                      <span className="w-4 shrink-0 text-slate-400">{index + 1}</span>
                      <span className="w-24 shrink-0 truncate text-slate-700" title={customer.name}>
                        {customer.name}
                      </span>
                      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.max((customer.orders / max) * 100, 6)}%`,
                            backgroundColor: kpi.accent,
                          }}
                        />
                      </span>
                      <span className="w-6 shrink-0 text-right font-medium text-slate-600">
                        {customer.orders}
                      </span>
                    </li>
                  ));
                })()}
              </ul>
            </>
          ) : (
            <p className="text-xs text-slate-400">
              No verified customer-linking column on this schema — showing the
              active-customer count only.
            </p>
          )}
          <div className="mt-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
            <span className="font-medium text-slate-700">Source: </span>
            <span>{kpi.source}</span>
          </div>
        </div>
      ) : (
      <div
        className="relative mt-4 overflow-hidden rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2"
        onMouseLeave={() => setActivePointIndex(null)}
      >
        {activePoint ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[132px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-xl shadow-slate-950/10"
            style={{
              left: tooltipLeft,
              top: tooltipTop,
            }}
          >
            <p className="font-semibold text-slate-950">{activePoint.label}</p>
            <p className="mt-1 font-medium" style={{ color: kpi.accent }}>
              {activePoint.value}
            </p>
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-[150px] w-full"
          role="img"
          aria-label={`${kpi.label} mini chart with hover values`}
        >
          <line
            x1={plot.left}
            y1={plot.top}
            x2={plot.left}
            y2={plot.top + plotHeight}
            stroke="#cbd5e1"
            strokeWidth="1.5"
          />
          <line
            x1={plot.left}
            y1={plot.top + plotHeight}
            x2={plot.left + plotWidth}
            y2={plot.top + plotHeight}
            stroke="#cbd5e1"
            strokeWidth="1.5"
          />
          {[0.25, 0.5, 0.75].map((tick) => (
            <line
              key={tick}
              x1={plot.left}
              y1={plot.top + plotHeight * tick}
              x2={plot.left + plotWidth}
              y2={plot.top + plotHeight * tick}
              stroke="#e2e8f0"
              strokeWidth="1"
            />
          ))}
          <text x="0" y={plot.top + 4} className="fill-slate-500 text-[10px]">
            {kpi.axis.yMax}
          </text>
          <text x="0" y={plot.top + plotHeight} className="fill-slate-500 text-[10px]">
            {kpi.axis.yMin}
          </text>
          <polyline
            points={points}
            fill="none"
            stroke={kpi.accent}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3.5"
          />
          {activePoint ? (
            <>
              <line
                x1={activePoint.x}
                y1={plot.top}
                x2={activePoint.x}
                y2={plot.top + plotHeight}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                strokeWidth="1.5"
              />
            </>
          ) : null}
          {chartPoints.map((point, index) => (
            <circle
              key={`hit-${point.label}-${point.value}`}
              cx={point.x}
              cy={point.y}
              r="10"
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setActivePointIndex(index)}
              onFocus={() => setActivePointIndex(index)}
            />
          ))}
          {activePoint ? (
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r="6.5"
              fill="white"
              stroke={kpi.accent}
              strokeWidth="3"
            />
          ) : null}
          <text
            x={plot.left}
            y={chartHeight - 5}
            className="fill-slate-500 text-[10px]"
          >
            {kpi.axis.xStart}
          </text>
          <text
            x={plot.left + plotWidth}
            y={chartHeight - 5}
            textAnchor="end"
            className="fill-slate-500 text-[10px]"
          >
            {kpi.axis.xEnd}
          </text>
        </svg>
        <div className="mt-2 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
          <span className="font-medium text-slate-700">Source: </span>
          <span>{kpi.source}</span>
        </div>
      </div>

      )}
      <p className="mt-auto border-t border-slate-100 pt-3 text-xs text-slate-500">
        {kpi.footer}
      </p>
    </section>
  );
}

type PinnedView = {
  title: string;
  meta: string;
  status: 'Live' | 'Snapshot' | 'Freeze';
  days: number;
  region: string | null;
};

type FilterHistoryEntry = {
  label: string;
  timeLabel: string;
  timestamp: number;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

const DEFAULT_WINDOW_DAYS = 30;
const SUGGESTED_PROMPTS = [
  'Show revenue by region',
  'Explain average order value',
  'Compare paid and pending orders',
  'Which products drive revenue?',
];

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const DATE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 365 days', days: 365 },
];

function AssistantPanel({
  chatInput,
  chatMessages,
  data,
  frozen,
  loading,
  onInputChange,
  onSubmit,
  onUsePrompt,
}: {
  chatInput: string;
  chatMessages: ChatMessage[];
  data: DashboardData;
  frozen: boolean;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
}) {
  return (
    <aside className="hidden h-screen w-[340px] shrink-0 overflow-hidden border-l border-slate-200/80 bg-white/95 shadow-[-8px_0_30px_rgb(15_23_42/4%)] xl:flex xl:flex-col">
      <div className="shrink-0 border-b border-slate-200/80 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 shadow-sm">
            <MessageSquareText size={18} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-950">Chat with Data</h2>
            <p className="text-xs text-slate-500">Answers, sources, and generated analysis.</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {chatMessages.length === 0 ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
              Ask a question about the live ecommerce data, or request a new analysis page. Numbers are pulled from the read-only database path.
            </div>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Try asking</p>
              <div className="space-y-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onUsePrompt(prompt)}
                    className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                  >
                    <SlidersHorizontal size={15} className="shrink-0 text-blue-600" />
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {chatMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}-${message.text}`}
                className={`rounded-xl border px-3 py-2.5 text-sm shadow-sm ${
                  message.role === 'user'
                    ? 'ml-8 border-blue-100 bg-blue-50 text-blue-950'
                    : 'mr-8 border-slate-200 bg-slate-50/90 text-slate-700'
                }`}
              >
                <p className="mb-1 text-[11px] font-semibold uppercase text-slate-400">
                  {message.role === 'user' ? 'You' : 'Assistant'}
                </p>
                <p className="leading-5">{message.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-slate-200/80 bg-white/95 p-4">
        <div className="rounded-xl border border-blue-200 bg-white p-2 shadow-[0_10px_25px_rgb(37_99_235/10%)]">
          <textarea
            value={chatInput}
            onChange={(event) => onInputChange(event.target.value)}
            className="min-h-20 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            placeholder={frozen ? 'Unfreeze this page before asking.' : data.promptSuggestion}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <StatusBadge status={frozen ? 'Freeze' : 'Live'} />
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-2 rounded-lg bg-blue-600 px-4 font-semibold shadow-sm shadow-blue-600/20 hover:bg-blue-700"
              disabled={loading || frozen || !chatInput.trim()}
            >
              <Send size={15} />
              {loading ? 'Working' : 'Ask'}
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}

export function DashboardShell({ data: initialData }: { data: DashboardData }) {
  const [data, setData] = useState(initialData);
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const [region, setRegion] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const [pinnedViews, setPinnedViews] = useState<PinnedView[]>([]);
  const [filterHistory, setFilterHistory] = useState<FilterHistoryEntry[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const regionOptions = Array.from(
    new Set(initialData.regionRevenue.map((row) => row.region)),
  );

  async function applyFilters(nextDays: number, nextRegion: string | null) {
    if (frozen) return;
    setLoading(true);
    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_READONLY_API_URL ?? 'http://localhost:4100/api/dashboard';
      const url = new URL(apiUrl);
      url.searchParams.set('days', String(nextDays));
      if (nextRegion) url.searchParams.set('region', nextRegion);

      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as DashboardData;

      setData(next);
      setDays(nextDays);
      setRegion(nextRegion);
      setFilterHistory((prev) => [
        {
          label: nextRegion ? `${nextRegion} Region, last ${nextDays}d` : `Last ${nextDays} days, all regions`,
          timeLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          timestamp: Date.now(),
        },
        ...prev,
      ].slice(0, 8));
    } catch (error) {
      console.error('Failed to refetch dashboard data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleChatSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || frozen) return;

    setChatInput('');
    setLoading(true);
    setChatMessages((prev) => [...prev, { role: 'user' as const, text: message }].slice(-6));

    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_CHAT_API_URL ?? 'http://localhost:4100/api/chat';
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          page_state: {
            page: 'home',
            days,
            region,
            availableRegions: regionOptions,
            kpis: data.kpis.map((kpi) => kpi.label),
            chartSources: data.chartSources,
          },
        }),
      });

      if (!response.ok) throw new Error(await response.text());

      const result = (await response.json()) as ChatResponse;
      setData(result.data);
      setDays(result.filters.days);
      setRegion(result.filters.region);
      setFilterHistory((prev) => [
        {
          label:
            result.filters.region === null
              ? `${result.title}, last ${result.filters.days}d`
              : `${result.title}, ${result.filters.region}, last ${result.filters.days}d`,
          timeLabel: new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          }),
          timestamp: Date.now(),
        },
        ...prev,
      ].slice(0, 8));
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant' as const,
          text: `${result.intent === 'mutate_current_page' ? 'Updated this page' : 'Created a new page'}: ${result.narrative}`,
        },
      ].slice(-6));
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant' as const,
          text:
            error instanceof Error
              ? `I could not update the dashboard: ${error.message}`
              : 'I could not update the dashboard.',
        },
      ].slice(-6));
    } finally {
      setLoading(false);
    }
  }

  function handlePin() {
    setPinnedViews((prev) => [
      {
        title: region ? `${region} Region` : `Last ${days} days`,
        meta: `${days}d window${region ? `, ${region}` : ''}`,
        status: 'Live' as const,
        days,
        region,
      },
      ...prev.filter((view) => !(view.days === days && view.region === region)),
    ]);
  }

  function handleUnpin(view: PinnedView) {
    setPinnedViews((prev) =>
      prev.filter((existing) => !(existing.days === view.days && existing.region === view.region)),
    );
  }

  function handleExport() {
    downloadCsv(`dashboard-export-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Metric', 'Value', 'Detail'],
      ...data.kpis.map((kpi) => [kpi.label, kpi.value, kpi.detail]),
    ]);
  }

  function handleExportTopProducts() {
    downloadCsv(`top-products-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Product', 'Revenue', 'Share', 'Units', 'AOV', 'Source'],
      ...data.topProducts,
    ]);
  }

  function handleExportRepeatCustomers() {
    downloadCsv(`repeat-customers-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Customer', 'Orders', 'Revenue', 'Last Order'],
      ...data.repeatCustomers,
    ]);
  }

  function handleExportRegionBreakdown() {
    downloadCsv(`region-breakdown-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Region', 'Revenue'],
      ...data.regionRevenue.map((row) => [row.region, String(row.revenue)]),
    ]);
  }

  return (
    <main className="h-screen overflow-hidden bg-slate-100 text-slate-950">
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          pinnedViews={pinnedViews}
          onSelectPinned={(view) => applyFilters(view.days, view.region)}
          onUnpin={handleUnpin}
          filterHistory={filterHistory}
          onExportTopProducts={handleExportTopProducts}
          onExportRepeatCustomers={handleExportRepeatCustomers}
          onExportRegionBreakdown={handleExportRegionBreakdown}
        />

        <div className="flex min-w-0 flex-1 overflow-hidden">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="truncate text-lg font-bold tracking-tight text-slate-950 min-[1400px]:text-xl min-[1700px]:text-2xl">
                  Home Dashboard
                </h1>
                <span className="shrink-0">
                  <StatusBadge status={frozen ? 'Freeze' : 'Live'} />
                </span>
              </div>
            </div>
            <div className="hidden shrink-0 items-center justify-end gap-1.5 md:flex">
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-2.5 text-sm font-semibold shadow-sm hover:bg-white"
                  onClick={() => {
                    setDateMenuOpen((open) => !open);
                    setRegionMenuOpen(false);
                  }}
                >
                  <CalendarDays size={15} />
                  {data.dateRange}
                </Button>
                {dateMenuOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                    {DATE_PRESETS.map((preset) => (
                      <button
                        key={preset.days}
                        className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                          preset.days === days ? 'font-medium text-blue-700' : 'text-slate-700'
                        }`}
                        onClick={() => {
                          setDateMenuOpen(false);
                          applyFilters(preset.days, region);
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-2.5 text-sm font-semibold shadow-sm hover:bg-white"
                  onClick={() => {
                    setRegionMenuOpen((open) => !open);
                    setDateMenuOpen(false);
                  }}
                >
                  <SlidersHorizontal size={15} />
                  {region ?? 'All regions'}
                </Button>
                {regionMenuOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                    <button
                      className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                        region === null ? 'font-medium text-blue-700' : 'text-slate-700'
                      }`}
                      onClick={() => {
                        setRegionMenuOpen(false);
                        applyFilters(days, null);
                      }}
                    >
                      All regions
                    </button>
                    {regionOptions.map((option) => (
                      <button
                        key={option}
                        className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                          region === option ? 'font-medium text-blue-700' : 'text-slate-700'
                        }`}
                        onClick={() => {
                          setRegionMenuOpen(false);
                          applyFilters(days, option);
                        }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <Button
                variant="outline"
                size="sm"
                title={frozen ? 'Frozen' : 'Freeze'}
                className={`h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-3 text-sm font-semibold shadow-sm hover:bg-white ${frozen ? 'border-amber-300 bg-amber-50 text-amber-700' : ''}`}
                onClick={() => setFrozen((value) => !value)}
              >
                <Snowflake size={15} />
                <span>{frozen ? 'Frozen' : 'Freeze'}</span>
              </Button>
              <Button variant="outline" size="sm" title="Pin" className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-3 text-sm font-semibold shadow-sm hover:bg-white" onClick={handlePin}>
                <Pin size={15} />
                <span>Pin</span>
              </Button>
              <Button variant="outline" size="sm" title="Export" className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-3 text-sm font-semibold shadow-sm hover:bg-white" onClick={handleExport}>
                <Download size={15} />
                <span>Export</span>
              </Button>
              {loading ? <span className="text-xs text-slate-400">Refreshing…</span> : null}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-auto bg-slate-100 px-4 pb-6 pt-5 sm:px-6">
            <div className="grid gap-4 md:grid-cols-2 min-[1800px]:grid-cols-4">
              {data.kpis.map((kpi) => (
                <KpiCard
                  key={kpi.label}
                  kpi={kpi}
                  topCustomers={kpi.label === 'Active Customers' ? data.topCustomersByOrders : undefined}
                />
              ))}
            </div>

            <div className="mt-4 grid gap-4">
              <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">Revenue Over Time</h2>
                    <p className="text-xs text-slate-500">{data.chartSources.trend}</p>
                  </div>
                  <MoreHorizontal size={18} className="text-slate-400" />
                </div>
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.revenueTrend}>
                      <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
                      <YAxis tickLine={false} axisLine={false} fontSize={12} />
                      <Tooltip />
                      <Area
                        type="monotone"
                        dataKey="revenue"
                        stroke="#0f9f9a"
                        fill="#ccfbf1"
                        strokeWidth={3}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">Revenue by Region</h2>
                    <p className="text-xs text-slate-500">{data.chartSources.region}</p>
                  </div>
                  <MoreHorizontal size={18} className="text-slate-400" />
                </div>
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.regionRevenue}
                      layout="vertical"
                      margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
                      barCategoryGap="28%"
                    >
                      <XAxis type="number" hide />
                      <YAxis
                        type="category"
                        dataKey="region"
                        tickLine={false}
                        axisLine={false}
                        width={40}
                        fontSize={12}
                      />
                      <Tooltip />
                      <Bar dataKey="revenue" radius={[0, 5, 5, 0]} fill="#2563eb" maxBarSize={36} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">Orders by Status</h2>
                    <p className="text-xs text-slate-500">{data.chartSources.channel}</p>
                  </div>
                  <MoreHorizontal size={18} className="text-slate-400" />
                </div>
                <div className="h-[340px] overflow-hidden">
                  <ul className="mb-4 grid gap-2 sm:grid-cols-2">
                    {(() => {
                      const total = data.channelRevenue.reduce((sum, entry) => sum + entry.value, 0);
                      return data.channelRevenue.map((entry) => (
                        <li key={entry.name} className="grid grid-cols-[12px_minmax(0,1fr)_48px] items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: entry.fill }}
                          />
                          <span className="min-w-0 truncate text-slate-700">{entry.name}</span>
                          <span className="text-right font-semibold text-slate-500">
                            {total ? `${Math.round((entry.value / total) * 1000) / 10}%` : '0%'}
                          </span>
                        </li>
                      ));
                    })()}
                  </ul>
                  <div className="mx-auto h-[min(260px,calc(100%-72px))] w-full max-w-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.channelRevenue}
                          dataKey="value"
                          cx="50%"
                          cy="50%"
                          innerRadius="62%"
                          outerRadius="95%"
                          paddingAngle={2}
                        >
                          {data.channelRevenue.map((entry) => (
                            <Cell key={entry.name} fill={entry.fill} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </section>
            </div>

            <div className="mt-4 grid gap-4">
              <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="flex items-center justify-between border-b border-slate-200/80 bg-white px-5 py-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">Top Products by Revenue</h2>
                    <p className="text-xs text-slate-500">{data.chartSources.products}</p>
                  </div>
                  <Button variant="ghost" size="sm">View all</Button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        {['Product', 'Revenue', 'Share', 'Units', 'AOV', 'Source'].map((head) => (
                          <th key={head} className="px-4 py-3 font-semibold">{head}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.topProducts.map((row) => (
                        <tr key={row[0]} className="border-t border-slate-100 transition hover:bg-slate-50/70">
                          {row.map((cell, index) => (
                            <td
                              key={`${row[0]}-${cell}`}
                              className={`px-4 py-3 ${
                                index === 5 && cell.startsWith('-')
                                  ? 'text-red-600'
                                  : index === 5
                                    ? 'text-emerald-600'
                                    : 'text-slate-700'
                              }`}
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="border-b border-slate-200/80 bg-white px-5 py-4">
                  <h2 className="text-base font-bold text-slate-950">Anomalies & Variances</h2>
                  <p className="text-xs text-slate-500">{data.chartSources.anomalies}</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {data.anomalies.map(([label, date, value, delta, status], index) => (
                    <div key={`${label}-${date}-${index}`} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50/70">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          status === 'critical'
                            ? 'bg-red-500'
                            : status === 'warning'
                              ? 'bg-amber-500'
                              : status === 'success'
                                ? 'bg-emerald-500'
                                : 'bg-blue-500'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{label}</p>
                        <p className="text-xs text-slate-500">{date}</p>
                      </div>
                      <p className="text-sm font-medium">{value}</p>
                      <p className={delta.startsWith('-') ? 'text-sm text-red-600' : 'text-sm text-emerald-600'}>
                        {delta}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {data.repeatCustomers.length > 0 ? (
              <section className="mt-4 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
                <div className="border-b border-slate-200/80 bg-white px-5 py-4">
                  <h2 className="text-base font-bold text-slate-950">Repeat Customers</h2>
                  <p className="text-xs text-slate-500">
                    Customers with more than one order (all-time)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        {['Customer', 'Orders', 'Revenue', 'Last Order'].map((head) => (
                          <th key={head} className="px-4 py-3 font-semibold">{head}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.repeatCustomers.map((row) => (
                        <tr key={row[0]} className="border-t border-slate-100 transition hover:bg-slate-50/70">
                          {row.map((cell, index) => (
                            <td
                              key={`${row[0]}-${index}`}
                              className={`px-4 py-3 ${
                                index === 0 ? 'font-medium text-slate-900' : 'text-slate-700'
                              }`}
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
          </section>
          <AssistantPanel
            chatInput={chatInput}
            chatMessages={chatMessages}
            data={data}
            frozen={frozen}
            loading={loading}
            onInputChange={setChatInput}
            onSubmit={handleChatSubmit}
            onUsePrompt={setChatInput}
          />
        </div>
      </div>
    </main>
  );
}
