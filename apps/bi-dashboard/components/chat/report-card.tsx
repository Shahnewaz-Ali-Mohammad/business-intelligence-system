import { FileSpreadsheet } from 'lucide-react';
import type { ReactNode } from 'react';

export function ReportCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="bi-message min-w-0 space-y-5 rounded-lg border border-zinc-200 bg-white p-4 sm:p-6">
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-700"><FileSpreadsheet size={16} /></div>
      <p className="text-base font-semibold tracking-normal text-zinc-800">{title}</p>
    </div>
    {children}
  </section>;
}
