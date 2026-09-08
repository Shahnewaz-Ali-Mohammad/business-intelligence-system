'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarDays, Download, MessageSquareText, Pin, SlidersHorizontal, Snowflake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DashboardData } from '@/lib/dashboard/metrics';
import { KpiCard } from './kpi-card';
import { Sidebar } from './sidebar';
import { StatusBadge } from './status-badge';
import { RevenueTrendChart } from './charts/revenue-trend-chart';
import { RegionRevenueChart } from './charts/region-revenue-chart';
import { StatusDonutChart } from './charts/status-donut-chart';
import { AnomaliesTable } from './tables/anomalies-table';
import { RepeatCustomersTable } from './tables/repeat-customers-table';
import { TopProductsTable } from './tables/top-products-table';
import type { FilterHistoryEntry, PinnedView } from './types';

const DEFAULT_WINDOW_DAYS = 30;

const DATE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 365 days', days: 365 },
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
  const [selectedGeneratedPage, setSelectedGeneratedPage] = useState<number | null>(null);

  const regionOptions = Array.from(new Set(initialData.regionRevenue.map((row) => row.region)));

  async function applyFilters(nextDays: number, nextRegion: string | null) {
    if (frozen) return;
    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_READONLY_API_URL ?? 'http://localhost:4100/api/dashboard';
      const url = new URL(apiUrl);
      url.searchParams.set('days', String(nextDays));
      if (nextRegion) url.searchParams.set('region', nextRegion);

      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as DashboardData;

      setData(next);
      setDays(nextDays);
      setRegion(nextRegion);
      const timestamp = Date.now();
      setSelectedGeneratedPage(timestamp);
      setFilterHistory((prev) => [
        {
          label: nextRegion ? `${nextRegion} Region, last ${nextDays}d` : `Last ${nextDays} days, all regions`,
          timeLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          timestamp,
          days: nextDays,
          region: nextRegion,
          data: next,
        },
        ...prev,
      ].slice(0, 8));
    } catch (error) {
      console.error('Failed to refetch dashboard data:', error);
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

  function handleSelectGeneratedPage(entry: FilterHistoryEntry) {
    setLoading(false);
    setData(entry.data);
    setDays(entry.days);
    setRegion(entry.region);
    setSelectedGeneratedPage(entry.timestamp);
    setDateMenuOpen(false);
    setRegionMenuOpen(false);
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
          selectedGeneratedPage={selectedGeneratedPage}
          onSelectGeneratedPage={handleSelectGeneratedPage}
          onExportTopProducts={handleExportTopProducts}
          onExportRepeatCustomers={handleExportRepeatCustomers}
          onExportRegionBreakdown={handleExportRegionBreakdown}
        />

        <div className="flex min-w-0 flex-1 overflow-hidden">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="relative z-50 flex h-20 shrink-0 items-center justify-between gap-3 border-b border-slate-200/80 bg-white px-4 py-3 shadow-sm sm:px-6">
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
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-2.5 text-sm font-semibold shadow-sm hover:bg-white" onClick={() => { setDateMenuOpen((open) => !open); setRegionMenuOpen(false); }}>
                    <CalendarDays size={15} />
                    {data.dateRange}
                  </Button>
                  {dateMenuOpen ? (
                    <div className="absolute right-0 top-full z-[80] mt-2 w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-950/20 ring-1 ring-slate-950/5">
                      {DATE_PRESETS.map((preset) => (
                        <button key={preset.days} className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${preset.days === days ? 'font-medium text-blue-700' : 'text-slate-700'}`} onClick={() => { setDateMenuOpen(false); applyFilters(preset.days, region); }}>
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="relative">
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-2.5 text-sm font-semibold shadow-sm hover:bg-white" onClick={() => { setRegionMenuOpen((open) => !open); setDateMenuOpen(false); }}>
                    <SlidersHorizontal size={15} />
                    {region ?? 'All regions'}
                  </Button>
                  {regionMenuOpen ? (
                    <div className="absolute right-0 top-full z-[80] mt-2 w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-950/20 ring-1 ring-slate-950/5">
                      <button className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${region === null ? 'font-medium text-blue-700' : 'text-slate-700'}`} onClick={() => { setRegionMenuOpen(false); applyFilters(days, null); }}>
                        All regions
                      </button>
                      {regionOptions.map((option) => (
                        <button key={option} className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${region === option ? 'font-medium text-blue-700' : 'text-slate-700'}`} onClick={() => { setRegionMenuOpen(false); applyFilters(days, option); }}>
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <Button variant="outline" size="sm" title={frozen ? 'Frozen' : 'Freeze'} className={`h-9 gap-1.5 rounded-lg border-slate-200 bg-slate-50 px-3 text-sm font-semibold shadow-sm hover:bg-white ${frozen ? 'border-amber-300 bg-amber-50 text-amber-700' : ''}`} onClick={() => setFrozen((value) => !value)}>
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
                {loading ? <span className="text-xs text-slate-400">Refreshing...</span> : null}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-auto bg-slate-100 px-4 pb-6 pt-6 sm:px-6">
              <section className="mb-4 flex flex-col gap-3 rounded-xl border border-blue-100 bg-white p-4 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white min-[1100px]:flex-row min-[1100px]:items-center min-[1100px]:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 shadow-sm">
                    <MessageSquareText size={18} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-slate-950">Ask Data Assistant</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Ask questions, generate reports, and create export-ready analysis from the ecommerce DB.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <Link
                    href="/chat"
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
                  >
                    Open Chat Workspace
                  </Link>
                  <Link
                    href="/reports"
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white"
                  >
                    View Reports
                  </Link>
                </div>
              </section>

              <div className="grid gap-4 md:grid-cols-2 min-[1800px]:grid-cols-4">
                {data.kpis.map((kpi) => (
                  <KpiCard key={kpi.label} kpi={kpi} topCustomers={kpi.label === 'Active Customers' ? data.topCustomersByOrders : undefined} />
                ))}
              </div>

              <div className="mt-4 grid gap-4">
                <RevenueTrendChart data={data} />
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <RegionRevenueChart data={data} />
                <StatusDonutChart data={data} />
              </div>

              <div className="mt-4 grid gap-4">
                <TopProductsTable data={data} />
                <AnomaliesTable data={data} />
              </div>

              <RepeatCustomersTable data={data} />
            </div>
          </section>

        </div>
      </div>
    </main>
  );
}
