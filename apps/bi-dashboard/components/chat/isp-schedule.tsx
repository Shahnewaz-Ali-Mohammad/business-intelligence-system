'use client';

import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { ScheduleForm, type ScheduleDraft, type ScheduleInput } from '@/components/data-sources/schedule-form';

/** What an original-chat answer needs to be saved and asked again on a schedule. */
export type IspScheduleRequest = {
  question: string;
  draft: ScheduleDraft;
  answer: { title: string; narrative: string; topic?: string; filters?: { days?: number; region?: string | null }; tablesUsed?: string[]; data?: Record<string, unknown> | null };
  sessionId?: number | null;
};

/**
 * "/schedule" in the original chat: confirms when to run, then saves the
 * answer as a report that the scheduler re-asks at each run.
 */
export function IspSchedule({ request }: { request: IspScheduleRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ reportId: number; description: string; nextRunAt?: number } | null>(null);

  async function confirm(schedule: ScheduleInput) {
    setBusy(true); setError('');
    try {
      const { question, answer } = request;
      const saved = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: answer.title || question.slice(0, 80),
          narrative: answer.narrative,
          topic: answer.topic ?? 'dashboard',
          chartType: 'none',
          filters: answer.filters ?? null,
          tablesUsed: answer.tablesUsed ?? [],
          data: { ...(answer.data || {}), ispQuestion: { question, days: answer.filters?.days ?? null, region: answer.filters?.region ?? null } },
          chartSpec: null,
          sourceSessionId: request.sessionId ?? null,
        }),
      });
      const report = await saved.json();
      if (!saved.ok || !Number.isSafeInteger(report.id)) throw new Error(report.error || 'Could not save the report.');
      const response = await fetch(`/api/reports/${report.id}/schedule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the schedule.');
      setDone({ reportId: report.id, description: data.description, nextRunAt: data.schedule?.nextRunAt });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the schedule.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 text-sm">
      {done ? (
        <p className="flex flex-wrap items-center gap-2 text-zinc-700">
          <CalendarClock size={15} className="text-rose-700" aria-hidden="true" />
          <span>Scheduled: {done.description}{done.nextRunAt ? ` · next run ${new Date(done.nextRunAt).toLocaleString()}` : ''}.</span>
          <a className="text-rose-700 underline" href={`/reports/${done.reportId}`}>Open report</a>
        </p>
      ) : (
        <>
          <p className="mb-2 flex items-center gap-2 font-medium text-zinc-800"><CalendarClock size={15} className="text-rose-700" aria-hidden="true" />Schedule this question</p>
          <ScheduleForm initial={request.draft} busy={busy} submitLabel="Confirm schedule" onSubmit={confirm} />
        </>
      )}
      {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
    </div>
  );
}
