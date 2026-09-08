'use client';

import { MoreHorizontal } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type Entry = { name: string; value: number };

export function TopEntitiesBarChart({
  title,
  subtitle,
  entries,
  valueFormatter,
}: {
  title: string;
  subtitle: string;
  entries: Entry[];
  valueFormatter?: (value: number) => string;
}) {
  const format = valueFormatter ?? ((value: number) => value.toLocaleString('en-US'));

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-950">{title}</h2>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <MoreHorizontal size={18} className="text-slate-400" />
      </div>
      {entries.length ? (
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={entries} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="22%">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={110} fontSize={11} />
              <Tooltip formatter={(value) => format(Number(value))} />
              <Bar dataKey="value" radius={[0, 5, 5, 0]} fill="#2563eb" maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-slate-400">No data available for this view.</p>
      )}
    </section>
  );
}
