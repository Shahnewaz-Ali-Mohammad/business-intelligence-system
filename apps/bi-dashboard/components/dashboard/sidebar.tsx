import Link from 'next/link';
import { BarChart3, Database, Download, FileText, FolderOpen, Home, LayoutDashboard, Pin, Search, ShieldCheck, Star, Table2, X } from 'lucide-react';
import { StatusBadge } from './status-badge';
import type { FilterHistoryEntry, PinnedView } from './types';

export function Sidebar({
  pinnedViews,
  onSelectPinned,
  onUnpin,
  filterHistory,
  selectedGeneratedPage,
  onSelectGeneratedPage,
  onExportTopProducts,
  onExportRepeatCustomers,
  onExportRegionBreakdown,
}: {
  pinnedViews: PinnedView[];
  onSelectPinned: (view: PinnedView) => void;
  onUnpin: (view: PinnedView) => void;
  filterHistory: FilterHistoryEntry[];
  selectedGeneratedPage: number | null;
  onSelectGeneratedPage: (entry: FilterHistoryEntry) => void;
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

      <div className="space-y-5 px-3.5 py-5">
        <nav className="space-y-1.5">
          <button className="flex w-full items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 text-left text-sm font-semibold text-blue-700 shadow-sm">
            <Home size={17} />
            Home Dashboard
            <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />
          </button>
          {[
            ['Chat', '/chat', Search],
            ['Sessions', '/sessions', BarChart3],
            ['Reports', '/reports', FileText],
            ['Exports', '/exports', Table2],
          ].map(([label, href, Icon]) => (
            <Link
              key={String(label)}
              href={String(href)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
            >
              <Icon size={16} className="text-slate-400" />
              <span>{String(label)}</span>
            </Link>
          ))}
        </nav>

        <nav className="space-y-2 border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Generated Pages</p>
            <FolderOpen size={14} className="text-slate-400" />
          </div>
          {filterHistory.length === 0 ? (
            <p className="px-3 text-xs text-slate-400">
              Ask the assistant for a new analysis page. Recent pages will appear here.
            </p>
          ) : null}
          {filterHistory.slice(0, 4).map((entry, index) => (
            <button
              key={`${entry.label}-${entry.timestamp}-${index}`}
              onClick={() => onSelectGeneratedPage(entry)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
                selectedGeneratedPage === entry.timestamp
                  ? 'bg-blue-50 text-blue-700 shadow-sm'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <FileText size={15} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.label}</span>
                <span className="block text-xs text-slate-400">{entry.timeLabel}</span>
              </span>
              <StatusBadge status="Live" />
            </button>
          ))}
        </nav>

        <nav className="space-y-2 border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Pinned Pages</p>
            <Pin size={14} className="text-slate-400" />
          </div>
          {pinnedViews.length === 0 ? (
            <p className="px-3 text-xs text-slate-400">
              Use Pin to save an important live or frozen view here.
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
                <Star size={15} className="shrink-0 text-slate-400" />
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
