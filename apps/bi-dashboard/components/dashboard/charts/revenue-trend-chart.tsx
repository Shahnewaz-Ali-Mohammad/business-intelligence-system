'use client';

import { MoreHorizontal } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function RevenueTrendChart({ data }: { data: DashboardData }) {
  return (
    <section className="rounded-lg border border-zinc-200/80 bg-white p-6 shadow-sm ring-1 ring-white">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-zinc-800">Revenue Over Time</h2>
          <p className="text-xs text-zinc-500">{data.chartSources.trend}</p>
        </div>
        <MoreHorizontal size={18} className="text-zinc-400" />
      </div>
      <div className="h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.revenueTrend}>
            <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickLine={false} axisLine={false} fontSize={12} />
            <Tooltip />
            <Area type="monotone" dataKey="revenue" stroke="#be123c" fill="#ffe4e6" strokeWidth={3} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
