import { Download, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';

const exports = [
  ['Regional Revenue.xlsx', 'Generated report · Excel'],
  ['Top Products.csv', 'Product report · CSV'],
  ['Repeat Customers.csv', 'Customer report · CSV'],
];

export default function ExportsPage() {
  return (
    <WorkspacePage active="Exports" title="Exports" subtitle="Download history for generated report files.">
      <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_12px_30px_rgb(15_23_42/7%)]">
        {exports.map(([name, meta]) => (
          <div key={name} className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 last:border-b-0">
            <FileSpreadsheet size={20} className="text-emerald-600" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{name}</p>
              <p className="text-sm text-slate-500">{meta}</p>
            </div>
            <Button variant="outline" size="sm" className="gap-2">
              <Download size={15} />
              Download
            </Button>
          </div>
        ))}
      </section>
    </WorkspacePage>
  );
}
