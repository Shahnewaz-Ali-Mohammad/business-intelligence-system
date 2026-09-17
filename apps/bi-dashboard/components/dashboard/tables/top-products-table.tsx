import { Button } from '@/components/ui/button';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function TopProductsTable({ data }: { data: DashboardData }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="flex items-center justify-between border-b border-slate-200/80 bg-white px-5 py-4">
        <div>
          {/* Relabeled from "Top Products by Revenue" -- there is no product
              concept in ISP billing. This table is repurposed as the top
              POPs (service areas) by real billing amount; see
              scripts/lib/dashboard-data.mjs's topProducts mapping comment. */}
          <h2 className="text-base font-bold text-slate-950">Top POPs by Billing</h2>
          <p className="text-xs text-slate-500">{data.chartSources.products}</p>
        </div>
        <Button variant="ghost" size="sm">View all</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
            <tr>{['POP', 'Billed', 'Share', 'Orders (N/A)', 'AOV (N/A)', 'Source'].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr>
          </thead>
          <tbody>
            {data.topProducts.map((row) => (
              <tr key={row[0]} className="border-t border-slate-100 transition hover:bg-slate-50/70">
                {row.map((cell, index) => (
                  <td key={`${row[0]}-${cell}`} className={`px-4 py-3 ${index === 5 && cell.startsWith('-') ? 'text-red-600' : index === 5 ? 'text-emerald-600' : 'text-slate-700'}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
