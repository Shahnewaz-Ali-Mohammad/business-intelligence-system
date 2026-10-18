'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Schedule = { enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; time: string; timezone: string; dayOfWeek?: number; dayOfMonth?: number; nextRunAt?: number | null; lastRunAt?: number; lastStatus?: string; lastError?: string | null; lastReportId?: number };
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
    fetch(`/api/reports/${reportId}/schedule`).then((r) => r.json()).then((data) => {
      if (cancelled || data.error) return;
      setState(data);
      if (data.schedule) setForm((f) => ({ ...f, ...data.schedule }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [reportId]);

  if (!state?.schedulable) return null;

  async function save(enabled: boolean) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/reports/${reportId}/schedule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, enabled }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the schedule.');
      setState((s) => ({ schedulable: true, ...s, schedule: data.schedule, description: data.description }));
      setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the schedule.'); }
    finally { setBusy(false); }
  }

  const schedule = state.schedule;
  const input = 'h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm';
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
        {!editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{schedule ? 'Change schedule' : 'Schedule'}</Button>}
        {!editing && schedule && <Button size="sm" variant="outline" disabled={busy} onClick={() => save(!schedule.enabled)}>{schedule.enabled ? 'Pause' : 'Resume'}</Button>}
      </div>
      {editing && (
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
          <label className="flex flex-col gap-1 text-xs text-zinc-600">Repeat
            <select className={input} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Schedule['frequency'] })}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
          </label>
          {form.frequency === 'weekly' && <label className="flex flex-col gap-1 text-xs text-zinc-600">On
            <select className={input} value={form.dayOfWeek ?? 1} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })}>{days.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          </label>}
          {form.frequency === 'monthly' && <label className="flex flex-col gap-1 text-xs text-zinc-600">Day of month
            <select className={input} value={form.dayOfMonth ?? 1} onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}{i + 1 > 28 ? ' (or last day)' : ''}</option>)}</select>
          </label>}
          <label className="flex flex-col gap-1 text-xs text-zinc-600">At
            <input type="time" required className={input} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          </label>
          <p className="pb-2 text-xs text-zinc-500">{form.timezone}</p>
          <Button size="sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save schedule'}</Button>
          <Button size="sm" type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
