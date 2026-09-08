import type { DashboardData } from '@/lib/dashboard/metrics';

export function AnomaliesTable({ data }: { data: DashboardData }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="border-b border-slate-200/80 bg-white px-5 py-4">
        <h2 className="text-base font-bold text-slate-950">Anomalies & Variances</h2>
        <p className="text-xs text-slate-500">{data.chartSources.anomalies}</p>
      </div>
      <div className="divide-y divide-slate-100">
        {data.anomalies.map(([label, date, value, delta, status], index) => (
          <div key={`${label}-${date}-${index}`} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50/70">
            <span className={`h-2.5 w-2.5 rounded-full ${status === 'critical' ? 'bg-red-500' : status === 'warning' ? 'bg-amber-500' : status === 'success' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{label}</p><p className="text-xs text-slate-500">{date}</p></div>
            <p className="text-sm font-medium">{value}</p>
            <p className={delta.startsWith('-') ? 'text-sm text-red-600' : 'text-sm text-emerald-600'}>{delta}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
