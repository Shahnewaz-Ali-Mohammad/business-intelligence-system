import type { DashboardData } from '@/lib/dashboard/metrics';

export function RepeatCustomersTable({ data }: { data: DashboardData }) {
  // data.repeatCustomers is always [] now -- this ISP warehouse has no real
  // "repeat customer" / cohort concept yet (see the TODO comment on
  // repeatCustomers in scripts/lib/dashboard-data.mjs). This component is
  // kept, rather than deleted, so it comes back to life automatically if a
  // real cohort breakdown is ever added there; until then it renders
  // nothing rather than showing stale or fabricated ecommerce-style rows.
  if (data.repeatCustomers.length === 0) return null;

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm ring-1 ring-white">
      <div className="border-b border-zinc-200/80 bg-white px-5 py-4">
        <h2 className="text-base font-bold text-zinc-800">Repeat Customers</h2>
        <p className="text-xs text-zinc-500">Customers with more than one order (all-time)</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-zinc-50/80 text-xs uppercase tracking-wide text-zinc-500">
            <tr>{['Customer', 'Orders', 'Revenue', 'Last Order'].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr>
          </thead>
          <tbody>
            {data.repeatCustomers.map((row) => (
              <tr key={row[0]} className="border-t border-zinc-100 transition hover:bg-zinc-50/70">
                {row.map((cell, index) => (
                  <td key={`${row[0]}-${index}`} className={`px-4 py-3 ${index === 0 ? 'font-medium text-zinc-800' : 'text-zinc-700'}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
