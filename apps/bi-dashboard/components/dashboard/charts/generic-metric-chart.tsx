'use client';

import { MoreHorizontal } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Entry = { name: string; value: number };

const PIE_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#f97316', '#16a34a', '#db2777', '#64748b', '#eab308'];

// Renders whatever chart format the user actually asked for (bar/line/pie/
// donut) over a generic name/value breakdown -- instead of the app only
// ever being able to draw one fixed chart shape.
export function GenericMetricChart({
  title,
  subtitle,
  entries,
  chartType,
}: {
  title: string;
  subtitle: string;
  entries: Entry[];
  chartType: 'bar' | 'line' | 'pie' | 'donut' | 'none';
}) {
  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-950">{title}</h2>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <MoreHorizontal size={18} className="text-slate-400" />
      </div>
      {!entries.length ? (
        <p className="py-10 text-center text-sm text-slate-400">No data available for this view.</p>
      ) : chartType === 'line' ? (
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={entries} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} width={48} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : chartType === 'pie' || chartType === 'donut' ? (
        <div className="h-[320px]">
          <ul className="mb-4 grid grid-cols-2 gap-2">
            {entries.slice(0, 8).map((entry, index) => (
              <li key={entry.name} className="grid grid-cols-[10px_minmax(0,1fr)] items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                <span className="min-w-0 truncate text-slate-700">{entry.name}</span>
              </li>
            ))}
          </ul>
          <div className="mx-auto h-[200px] w-full max-w-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={entries.slice(0, 8)}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={chartType === 'donut' ? '55%' : 0}
                  outerRadius="90%"
                  paddingAngle={2}
                >
                  {entries.slice(0, 8).map((entry, index) => (
                    <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={entries} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="22%">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={110} fontSize={11} />
              <Tooltip />
              <Bar dataKey="value" radius={[0, 5, 5, 0]} fill="#2563eb" maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
