'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScheduleForm, type ScheduleDraft } from './schedule-form';

type Schedule = { enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; time: string; timezone: string; dayOfWeek?: number; dayOfMonth?: number; nextRunAt?: number | null; lastRunAt?: number; lastStatus?: string; lastError?: string | null; lastReportId?: number };
const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : '—');

/** Lets the owner run a saved report automatically on a schedule. */
export function ReportSchedule({ reportId }: { reportId: number }) {
  const [state, setState] = useState<{ schedulable: boolean; schedule: Schedule | null; description: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Schedule>({ enabled: true, frequency: 'daily', time: '08:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, dayOfWeek: 1, dayOfMonth: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let initial = true;
    const refresh = () => fetch(`/api/reports/${reportId}/schedule`, { cache: 'no-store' }).then((r) => r.json()).then((data) => {
      if (cancelled || data.error) return;
      setState(data);
      if (initial && data.schedule) setForm((f) => ({ ...f, ...data.schedule }));
      initial = false;
    }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [reportId]);

  if (!state?.schedulable) return null;

  async function save(enabled: boolean, time = form.time, next: Partial<Schedule> & { dateRange?: string } = {}) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/reports/${reportId}/schedule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, ...next, time, enabled }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the schedule.');
      setState((s) => ({ schedulable: true, ...s, schedule: data.schedule, description: data.description }));
      setForm((f) => ({ ...f, ...data.schedule }));
      setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the schedule.'); }
    finally { setBusy(false); }
  }

  const schedule = state.schedule;
  return (
    <section aria-label="Report schedule" className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <CalendarClock size={18} className="text-rose-700" />
        <div className="min-w-0 flex-1 text-sm">
          {schedule ? (
            <>
              <p className="font-medium text-zinc-800">{schedule.enabled ? state.description : 'Schedule paused'}</p>
              <p className="text-xs text-zinc-500">
                {schedule.enabled && <>Next run: {when(schedule.nextRunAt)} · </>}
                Last run: {when(schedule.lastRunAt)}
                {schedule.lastStatus && <> · {schedule.lastStatus === 'failed' ? <span className="text-red-600">failed{schedule.lastError ? `: ${schedule.lastError}` : ''}</span> : schedule.lastStatus}</>}
                {schedule.lastReportId && <> · <Link className="text-rose-700" href={`/reports/${schedule.lastReportId}`}>Open latest run</Link></>}
              </p>
            </>
          ) : <p className="text-zinc-600">Run this report automatically and get a notification when it’s ready.</p>}
        </div>
        {!editing && <Button size="sm" variant="outline" onClick={() => { if (schedule) setForm((f) => ({ ...f, ...schedule })); setEditing(true); }}>{schedule ? 'Change schedule' : 'Schedule'}</Button>}
        {!editing && schedule && <Button size="sm" variant="outline" disabled={busy} onClick={() => save(!schedule.enabled)}>{schedule.enabled ? 'Pause' : 'Resume'}</Button>}
      </div>
      {editing && (
        <div className="mt-4">
          <ScheduleForm initial={form as ScheduleDraft} busy={busy} submitLabel="Save schedule" onCancel={() => setEditing(false)} onSubmit={(next) => { setForm((f) => ({ ...f, ...next })); void save(true, next.time, next); }} />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
