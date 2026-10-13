import { Button } from '@/components/ui/button';
import type { DashboardData } from '@/lib/dashboard/metrics';

export function TopProductsTable({ data }: { data: DashboardData }) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm ring-1 ring-white">
      <div className="flex items-center justify-between border-b border-zinc-200/80 bg-white px-5 py-4">
        <div>
          {/* Relabeled from "Top Products by Revenue" -- there is no product
              concept in ISP billing. This table is repurposed as the top
              POPs (service areas) by real billing amount; see
              scripts/lib/dashboard-data.mjs's topProducts mapping comment. */}
          <h2 className="text-base font-bold text-zinc-800">Top POPs by Billing</h2>
          <p className="text-xs text-zinc-500">{data.chartSources.products}</p>
        </div>
        <Button variant="ghost" size="sm">View all</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-zinc-50/80 text-xs uppercase tracking-wide text-zinc-500">
            <tr>{['POP', 'Billed', 'Share', 'Orders (N/A)', 'AOV (N/A)', 'Source'].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr>
          </thead>
          <tbody>
            {data.topProducts.map((row) => (
              <tr key={row[0]} className="border-t border-zinc-100 transition hover:bg-zinc-50/70">
                {row.map((cell, index) => (
                  <td key={`${row[0]}-${cell}`} className={`px-4 py-3 ${index === 5 && cell.startsWith('-') ? 'text-red-600' : index === 5 ? 'text-emerald-600' : 'text-zinc-700'}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
