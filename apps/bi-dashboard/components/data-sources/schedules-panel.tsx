'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Item = { reportId: number; title: string; description: string; schedule: { enabled: boolean; frequency: string; time: string; timezone: string; dayOfWeek?: number; dayOfMonth?: number; dateRange?: string; nextRunAt?: number | null; lastRunAt?: number; lastStatus?: string; lastError?: string | null; lastReportId?: number } };
const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : '—');

/** "/schedules": every scheduled report of this database, with pause, resume and remove. */
export function SchedulesPanel({ workspaceId, sourceId, onClose }: { workspaceId: string; sourceId: string; onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const fetchSchedules = useCallback(() => fetch(`/api/workspaces/${workspaceId}/schedules?sourceId=${encodeURIComponent(sourceId)}`, { cache: 'no-store' }).then((r) => r.json()).then((data) => (data.schedules || []) as Item[]), [workspaceId, sourceId]);
  const load = useCallback(async () => {
    try { setItems(await fetchSchedules()); } catch { setError('Could not load schedules.'); }
  }, [fetchSchedules]);
  useEffect(() => {
    let cancelled = false;
    fetchSchedules().then((list) => { if (!cancelled) setItems(list); }).catch(() => { if (!cancelled) setError('Could not load schedules.'); });
    return () => { cancelled = true; };
  }, [fetchSchedules]);

  async function change(item: Item, action: 'pause' | 'resume' | 'remove') {
    setBusy(item.reportId); setError('');
    try {
      const response = action === 'remove'
        ? await fetch(`/api/reports/${item.reportId}/schedule`, { method: 'DELETE' })
        : await fetch(`/api/reports/${item.reportId}/schedule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item.schedule, enabled: action === 'resume' }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not update the schedule.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update the schedule.'); }
    finally { setBusy(null); }
  }

  return (
    <section aria-label="Scheduled reports" className="mx-3 mb-3 max-h-[50vh] shrink-0 overflow-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><CalendarClock size={16} className="text-rose-700" />Scheduled reports</h3>
        <button type="button" aria-label="Close schedules" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X size={16} /></button>
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      {items === null ? <p role="status" className="text-sm text-zinc-500">Loading…</p> : items.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing scheduled yet. Type <code>/schedule</code> followed by a question, e.g. <em>/schedule customers per package every Monday at 9am</em>, or use Schedule on any answer.</p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {items.map((item) => (
            <li key={item.reportId} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/reports/${item.reportId}`} className="text-sm font-medium text-zinc-800 hover:text-rose-700">{item.title}</Link>
                <p className="text-xs text-zinc-500">{item.schedule.enabled ? item.description : 'Paused'}</p>
                <p className="text-xs text-zinc-500">
                  {item.schedule.enabled && <>Next: {when(item.schedule.nextRunAt)} · </>}Last: {when(item.schedule.lastRunAt)}
                  {item.schedule.lastStatus && <> · {item.schedule.lastStatus === 'failed' ? <span className="text-red-600">failed</span> : item.schedule.lastStatus}</>}
                  {item.schedule.lastReportId && <> · <Link className="text-rose-700" href={`/reports/${item.schedule.lastReportId}`}>latest result</Link></>}
                </p>
              </div>
              <Button size="sm" variant="outline" disabled={busy === item.reportId} onClick={() => change(item, item.schedule.enabled ? 'pause' : 'resume')}>{item.schedule.enabled ? 'Pause' : 'Resume'}</Button>
              <Button size="sm" variant="outline" disabled={busy === item.reportId} onClick={() => change(item, 'remove')}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
