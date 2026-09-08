'use client';

import { MoreHorizontal } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function RevenueTrendChart({ data }: { data: DashboardData }) {
  return (
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
            <Area type="monotone" dataKey="revenue" stroke="#0f9f9a" fill="#ccfbf1" strokeWidth={3} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
