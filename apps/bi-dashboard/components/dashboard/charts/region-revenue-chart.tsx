'use client';

import { MoreHorizontal } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function RegionRevenueChart({ data }: { data: DashboardData }) {
  return (
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
          <BarChart data={data.regionRevenue} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="region" tickLine={false} axisLine={false} width={40} fontSize={12} />
            <Tooltip />
            <Bar dataKey="revenue" radius={[0, 5, 5, 0]} fill="#2563eb" maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
