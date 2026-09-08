'use client';

import { MoreHorizontal } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function StatusDonutChart({ data }: { data: DashboardData }) {
  const total = data.channelRevenue.reduce((sum, entry) => sum + entry.value, 0);

  return (
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
          {data.channelRevenue.map((entry) => (
            <li key={entry.name} className="grid grid-cols-[12px_minmax(0,1fr)_48px] items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: entry.fill }} />
              <span className="min-w-0 truncate text-slate-700">{entry.name}</span>
              <span className="text-right font-semibold text-slate-500">{total ? `${Math.round((entry.value / total) * 1000) / 10}%` : '0%'}</span>
            </li>
          ))}
        </ul>
        <div className="mx-auto h-[min(260px,calc(100%-72px))] w-full max-w-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data.channelRevenue} dataKey="value" cx="50%" cy="50%" innerRadius="62%" outerRadius="95%" paddingAngle={2}>
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
  );
}
