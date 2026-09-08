import type { DashboardData } from '@/lib/dashboard/metrics';

export function RepeatCustomersTable({ data }: { data: DashboardData }) {
  if (data.repeatCustomers.length === 0) return null;

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="border-b border-slate-200/80 bg-white px-5 py-4">
        <h2 className="text-base font-bold text-slate-950">Repeat Customers</h2>
        <p className="text-xs text-slate-500">Customers with more than one order (all-time)</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
            <tr>{['Customer', 'Orders', 'Revenue', 'Last Order'].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr>
          </thead>
          <tbody>
            {data.repeatCustomers.map((row) => (
              <tr key={row[0]} className="border-t border-slate-100 transition hover:bg-slate-50/70">
                {row.map((cell, index) => (
                  <td key={`${row[0]}-${index}`} className={`px-4 py-3 ${index === 0 ? 'font-medium text-slate-900' : 'text-slate-700'}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
