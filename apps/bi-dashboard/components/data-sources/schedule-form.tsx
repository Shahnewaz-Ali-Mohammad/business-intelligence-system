'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export type ScheduleDraft = { frequency?: 'daily' | 'weekly' | 'monthly' | null; time?: string | null; dayOfWeek?: number; dayOfMonth?: number; dateRange?: string | null };
export type ScheduleInput = { enabled: boolean; frequency: 'daily' | 'weekly' | 'monthly'; time: string; timezone: string; dayOfWeek?: number; dayOfMonth?: number; dateRange: string };

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DATE_RANGE_OPTIONS: [string, string][] = [
  ['none', 'Same dates as this report'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7_days', 'Last 7 days'],
  ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'],
];

/** Repeat / day / time / date-range fields for a report schedule. */
export function ScheduleForm({ initial, busy, submitLabel = 'Schedule', onSubmit, onCancel }: { initial?: ScheduleDraft; busy?: boolean; submitLabel?: string; onSubmit: (schedule: ScheduleInput) => void; onCancel?: () => void }) {
  const [form, setForm] = useState<ScheduleInput>({
    enabled: true,
    frequency: initial?.frequency || 'daily',
    time: initial?.time || '08:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayOfWeek: initial?.dayOfWeek ?? 1,
    dayOfMonth: initial?.dayOfMonth ?? 1,
    dateRange: initial?.dateRange || 'none',
  });
  const input = 'h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm';
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, time: String(new FormData(e.currentTarget).get('time') || form.time) }); }}>
      <label className="flex flex-col gap-1 text-xs text-zinc-600">Repeat
        <select className={input} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as ScheduleInput['frequency'] })}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select>
      </label>
      {form.frequency === 'weekly' && <label className="flex flex-col gap-1 text-xs text-zinc-600">On
        <select className={input} value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })}>{days.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
      </label>}
      {form.frequency === 'monthly' && <label className="flex flex-col gap-1 text-xs text-zinc-600">Day of month
        <select className={input} value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}{i + 1 > 28 ? ' (or last day)' : ''}</option>)}</select>
      </label>}
      <label className="flex flex-col gap-1 text-xs text-zinc-600">At
        <input type="time" name="time" required className={input} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-600">Data for
        <select className={input} value={form.dateRange} onChange={(e) => setForm({ ...form, dateRange: e.target.value })}>{DATE_RANGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <p className="pb-2 text-xs text-zinc-500">{form.timezone}</p>
      <Button size="sm" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
      {onCancel && <Button size="sm" type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
    </form>
  );
}
