'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ArtifactChartPicker } from '@/components/dashboard/charts/artifact-chart-picker';
import type { ChatResponse, DashboardData } from '@/lib/dashboard/metrics';

type Message = { role: 'user' | 'assistant'; text: string };

type PendingChange = {
  title: string;
  narrative: string;
  topic: string;
  chartType: 'bar' | 'line' | 'pie' | 'donut' | 'none';
  data: DashboardData;
  days: number;
  region: string | null;
  tablesUsed: string[];
};

export type AppliedReportFields = {
  title: string;
  narrative: string;
  topic: string | null;
  chart_type: 'bar' | 'line' | 'pie' | 'donut' | 'none' | null;
  filters: { days: number; region: string | null };
  tables_used: string[];
  data: DashboardData;
};

// A small chat box scoped to ONE saved report -- not a full conversation
// session. Ask for a change ("show this as a line chart", "filter to
// Europe") and it re-runs the same chat agent used on /chat, then shows a
// preview you can apply (overwrite this report) or discard. Nothing here
// is persisted to chat_sessions/chat_messages; it only exists to edit this
// one report and resets if the page reloads.
export function ReportChatEditor({
  reportId,
  currentTopic,
  currentDays,
  currentRegion,
  currentData,
  onApplied,
}: {
  reportId: number;
  currentTopic: string | null;
  currentDays: number;
  currentRegion: string | null;
  currentData: DashboardData;
  onApplied: (fields: AppliedReportFields) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [applying, setApplying] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || loading) return;

    setInput('');
    setLoading(true);
    setMessages((prev) => [...prev, { role: 'user', text: message }]);

    try {
      const response = await fetch(process.env.NEXT_PUBLIC_CHAT_API_URL ?? 'http://localhost:4100/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: messages.slice(-12).map((m) => ({ role: m.role, content: m.text })),
          page_state: {
            page: 'report',
            days: pending?.days ?? currentDays,
            region: pending?.region ?? currentRegion,
            kpis: currentData.kpis.map((kpi) => kpi.label),
            chartSources: currentData.chartSources,
          },
        }),
      });

      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as ChatResponse;
      setMessages((prev) => [...prev, { role: 'assistant', text: result.narrative }]);

      if (result.data && result.intent === 'create_new_page') {
        setPending({
          title: result.title,
          narrative: result.narrative,
          topic: result.topic ?? currentTopic ?? 'dashboard',
          chartType: result.chartType ?? 'bar',
          data: result.data,
          days: result.filters.days,
          region: result.filters.region,
          tablesUsed: result.tablesUsed,
        });
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: 'I could not complete that request.' }]);
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!pending) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/reports/${reportId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pending.title,
          narrative: pending.narrative,
          topic: pending.topic,
          chartType: pending.chartType,
          filters: { days: pending.days, region: pending.region },
          tablesUsed: pending.tablesUsed,
          data: pending.data,
        }),
      });
      if (res.ok) {
        onApplied({
          title: pending.title,
          narrative: pending.narrative,
          topic: pending.topic,
          chart_type: pending.chartType,
          filters: { days: pending.days, region: pending.region },
          tables_used: pending.tablesUsed,
          data: pending.data,
        });
        setPending(null);
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles size={16} className="text-blue-600" />
        <h2 className="text-base font-bold">Edit with Chat</h2>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Ask for a change (e.g. &quot;show this as a line chart&quot; or &quot;filter to Europe&quot;), then apply it to this report.
      </p>

      {messages.length > 0 ? (
        <div className="mb-3 max-h-56 space-y-2 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm">
          {messages.map((m, i) => (
            <p key={i} className={m.role === 'user' ? 'font-medium text-slate-900' : 'text-slate-600'}>
              {m.role === 'user' ? 'You: ' : 'Assistant: '}
              {m.text}
            </p>
          ))}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask for a change to this report..."
          disabled={loading}
          className="h-10 flex-1 rounded-md border border-slate-200 px-3 text-sm focus:border-blue-400 focus:outline-none"
        />
        <Button type="submit" disabled={loading || !input.trim()} className="gap-2">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          Send
        </Button>
      </form>

      {pending ? (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Preview of change</p>
          <ArtifactChartPicker title={pending.title} topic={pending.topic} chartType={pending.chartType} data={pending.data} />
          <div className="flex gap-2">
            <Button onClick={handleApply} disabled={applying} className="gap-2">
              {applying ? 'Applying...' : 'Apply to Report'}
            </Button>
            <Button variant="outline" onClick={() => setPending(null)} disabled={applying}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
