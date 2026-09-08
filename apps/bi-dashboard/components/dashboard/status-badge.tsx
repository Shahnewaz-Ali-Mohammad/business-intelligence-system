import { Badge } from '@/components/ui/badge';
import type { DashboardViewStatus } from './types';

export function StatusBadge({ status }: { status: DashboardViewStatus }) {
  const styles = {
    Live: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    Snapshot: 'border-blue-200 bg-blue-50 text-blue-700',
    Freeze: 'border-amber-200 bg-amber-50 text-amber-700',
  };

  return (
    <Badge variant="outline" className={`h-6 gap-1.5 rounded-md px-2.5 font-medium shadow-sm ${styles[status]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </Badge>
  );
}
