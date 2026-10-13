'use client';

import { MoreHorizontal } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function RegionRevenueChart({ data }: { data: DashboardData }) {
  return (
    <section className="rounded-lg border border-zinc-200/80 bg-white p-5 shadow-sm ring-1 ring-white">
      <div className="mb-4 flex items-center justify-between">
        <div>
          {/* "region" data key kept for this component's existing contract
              (see dashboard-data.mjs) -- the values are real POP ids, not
              ecommerce ship-country codes, so the visible label is
              corrected here to say what it actually shows. */}
          <h2 className="text-base font-bold text-zinc-800">Billing by POP</h2>
          <p className="text-xs text-zinc-500">{data.chartSources.region}</p>
        </div>
        <MoreHorizontal size={18} className="text-zinc-400" />
      </div>
      <div className="h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.regionRevenue} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="region" tickLine={false} axisLine={false} width={40} fontSize={12} />
            <Tooltip />
            <Bar dataKey="revenue" radius={[0, 5, 5, 0]} fill="#be123c" maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
