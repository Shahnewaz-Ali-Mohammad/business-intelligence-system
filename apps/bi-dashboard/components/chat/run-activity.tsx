'use client';

import { Check, Database, Loader2, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunPreview, RunStep, RunTool } from '@/lib/chat/agui-client';

const seconds = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const cell = (value: unknown) => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** Ticks once a second so the running stage shows a live duration. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}

export function StepList({ steps, tools = [], live = false }: { steps: RunStep[] | { name: string; ms: number }[]; tools?: RunTool[]; live?: boolean }) {
  const now = useNow(live);
  if (!steps.length && !tools.length) return null;
  return (
    <ol className="space-y-1 text-xs text-zinc-500" aria-label="Progress">
      {steps.map((step, index) => {
        const status = 'status' in step ? step.status : 'done';
        const ms = status === 'active' && 'started' in step && step.started ? now - step.started : step.ms;
        return (
          <li key={`${step.name}-${index}`} className="flex items-center gap-2">
            {status === 'active'
              ? <Loader2 size={13} className="animate-spin text-rose-700" aria-hidden="true" />
              : <Check size={13} className="text-emerald-600" aria-hidden="true" />}
            <span className={status === 'active' ? 'text-zinc-700' : ''}>{step.name}</span>
            {ms != null && ms >= 300 ? <span className="tabular-nums text-zinc-400">{seconds(ms)}</span> : null}
          </li>
        );
      })}
      {tools.map((tool) => (
        <li key={tool.id} className="flex items-center gap-2 pl-5">
          {tool.status === 'active'
            ? <Loader2 size={12} className="animate-spin text-zinc-400" aria-hidden="true" />
            : tool.status === 'failed' ? <X size={12} className="text-amber-600" aria-hidden="true" /> : <Database size={12} className="text-zinc-400" aria-hidden="true" />}
          <span>{tool.label}</span>
          {tool.status === 'done' && tool.rows != null ? <span className="tabular-nums text-zinc-400">{tool.rows.toLocaleString()} {tool.rows === 1 ? 'row' : 'rows'}</span> : null}
          {tool.ms != null && tool.status !== 'active' ? <span className="tabular-nums text-zinc-400">{seconds(tool.ms)}</span> : null}
          {tool.status === 'failed' && tool.note ? <span className="text-amber-700">{tool.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The result table as soon as the query returns, while the insight is still being written. */
export function ResultPreview({ preview }: { preview: RunPreview }) {
  if (!preview.rows?.length) return null;
  const columns = Object.keys(preview.rows[0]).slice(0, 6);
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-zinc-200">
      <div className="flex items-center justify-between bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600">
        <span className="font-medium">{preview.title || 'Results'}</span>
        {preview.totalCount != null ? <span className="tabular-nums">{preview.totalCount.toLocaleString()} {preview.mode === 'aggregate' ? 'groups' : 'records'}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500"><tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-1.5 font-medium">{c}</th>)}</tr></thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index} className="border-t border-zinc-100 text-zinc-700">
                {columns.map((c) => <td key={c} className="max-w-[16rem] truncate whitespace-nowrap px-3 py-1.5">{cell(row[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-zinc-100 px-3 py-1 text-[11px] text-zinc-400">Preview. The full table appears when the answer is ready.</p>
    </div>
  );
}

export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button type="button" onClick={onStop} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50">
      <Square size={10} className="fill-current" aria-hidden="true" /> Stop
    </button>
  );
}

/** Steps of a finished answer, folded away under the message. */
export function SavedSteps({ steps }: { steps?: { name: string; ms: number }[] }) {
  if (!steps?.length) return null;
  const total = steps.reduce((sum, s) => sum + (Number(s.ms) || 0), 0);
  return (
    <details className="mt-1 ml-1 text-[11px] text-zinc-400">
      <summary className="cursor-pointer select-none">{steps.length} steps · {seconds(total)}</summary>
      <div className="mt-1"><StepList steps={steps} /></div>
    </details>
  );
}
