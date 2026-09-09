'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  FileSpreadsheet,
  LogIn,
  Plus,
  Save,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ArtifactChartPicker } from '@/components/dashboard/charts/artifact-chart-picker';
import { useAuth } from '@/components/auth/auth-provider';
import { getReportTable } from '@/lib/dashboard/report-table';
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, triggerDownload } from '@/lib/download';
import type { ChatResponse, DashboardData } from '@/lib/dashboard/metrics';

type Artifact = {
  title: string;
  narrative: string;
  topic: string;
  chartType: 'bar' | 'line' | 'pie' | 'donut' | 'none';
  data: DashboardData;
  days: number;
  region: string | null;
  tablesUsed: string[];
};

type Message = {
  role: 'user' | 'assistant';
  text: string;
  tablesUsed?: string[];
  artifact?: Artifact;
};

const WELCOME_MESSAGE: Message = {
  role: 'assistant',
  text: 'Hi. Ask about revenue, orders, regions, products, or request a report from the ecommerce DB.',
};

async function saveMessage(sessionId: number, role: 'user' | 'assistant', text: string, tablesUsed?: string[]) {
  try {
    await fetch('/api/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, role, content: text, tablesUsed }),
    });
  } catch {
    // Best-effort persistence -- a failed save should never block the chat UI.
  }
}

// Saving is a deliberate, user-initiated action (the "Save Report" button
// under a message's chart) -- it never happens automatically just because a
// chart was generated, so the Reports list only fills up with reports the
// user actually chose to keep.
async function saveReport(artifact: Artifact): Promise<boolean> {
  try {
    const response = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: artifact.title,
        narrative: artifact.narrative,
        topic: artifact.topic,
        chartType: artifact.chartType,
        filters: { days: artifact.days, region: artifact.region },
        tablesUsed: artifact.tablesUsed,
        data: artifact.data,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function ChatWorkspace({ initialData }: { initialData: DashboardData }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  // The most recently generated artifact is kept (but not shown as its own
  // panel) purely so a follow-up message like "and for Europe?" still has
  // the right days/region/kpis context to send the agent.
  const [lastArtifact, setLastArtifact] = useState<Artifact | null>(null);
  const [expandedReports, setExpandedReports] = useState<Set<number>>(new Set());
  const [reportSaveStates, setReportSaveStates] = useState<Record<number, 'idle' | 'saving' | 'saved' | 'error'>>({});
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const sessionSetupRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeData = lastArtifact?.data ?? initialData;

  // Load an existing conversation when the URL names one. A NEW conversation
  // is intentionally NOT created here -- creating it eagerly on page load
  // used to leave empty "New conversation" rows in Sessions before the user
  // ever typed anything. A session row is only created lazily, in
  // handleSubmit, the moment the user actually sends a first message.
  useEffect(() => {
    if (authLoading || !user || !requestedSessionId) return;
    const setupKey = `${user.id}:${requestedSessionId}`;
    if (sessionSetupRef.current === setupKey) return;
    sessionSetupRef.current = setupKey;

    fetch(`/api/chat-sessions/${requestedSessionId}`)
      .then((res) => res.json())
      .then((body: { session: { id: number; title: string } | null; messages: Array<{ role: 'user' | 'assistant'; content: string; tables_used: string[] | null }> }) => {
        if (!body.session) return;
        setSessionId(body.session.id);
        setSessionTitle(body.session.title);
        if (body.messages.length) {
          setMessages(
            body.messages.map((m) => ({ role: m.role, text: m.content, tablesUsed: m.tables_used ?? undefined })),
          );
        }
      })
      .catch(() => {});
  }, [authLoading, user, requestedSessionId]);

  async function ensureSession(firstMessage: string): Promise<number | null> {
    if (!user) return null;
    if (sessionId) return sessionId;
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: firstMessage.slice(0, 80) }),
      });
      const body = (await res.json()) as { id: number; title: string };
      setSessionId(body.id);
      setSessionTitle(body.title);
      router.replace(`/chat?session=${body.id}`, { scroll: false });
      return body.id;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  function handleNewChat() {
    setMessages([WELCOME_MESSAGE]);
    setLastArtifact(null);
    setExpandedReports(new Set());
    setReportSaveStates({});
    setSessionId(null);
    setSessionTitle(null);
    sessionSetupRef.current = null;
    router.push('/chat');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || loading) return;

    const assistantMessageIndex = messages.length + 1;

    setInput('');
    setLoading(true);
    setMessages((prev) => [...prev, { role: 'user', text: message }]);
    const activeSessionId = await ensureSession(message);
    if (user && activeSessionId) {
      saveMessage(activeSessionId, 'user', message);
    }

    try {
      const response = await fetch(
        process.env.NEXT_PUBLIC_CHAT_API_URL ?? 'http://localhost:4100/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            // Recent turns so the agent has real conversation memory --
            // it can resolve follow-ups like "what about last quarter"
            // instead of treating every message as a blank slate.
            history: messages.slice(-12).map((m) => ({ role: m.role, content: m.text })),
            page_state: {
              page: 'chat',
              days: lastArtifact?.days ?? 30,
              region: lastArtifact?.region ?? null,
              kpis: activeData.kpis.map((kpi) => kpi.label),
              chartSources: activeData.chartSources,
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || 'Chat request failed');
      }

      const result = (await response.json()) as ChatResponse;
      const nextArtifact: Artifact | null =
        result.data && result.intent === 'create_new_page'
          ? {
              title: result.title,
              narrative: result.narrative,
              topic: result.topic ?? 'dashboard',
              chartType: result.chartType ?? 'bar',
              data: result.data,
              days: result.filters.days,
              region: result.filters.region,
              tablesUsed: result.tablesUsed,
            }
          : null;

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: result.narrative, tablesUsed: result.tablesUsed, artifact: nextArtifact ?? undefined },
      ]);
      if (user && activeSessionId) saveMessage(activeSessionId, 'assistant', result.narrative, result.tablesUsed);

      if (nextArtifact) {
        setLastArtifact(nextArtifact);
        // A freshly generated report opens automatically -- no need to
        // click through to see the chart you just asked for.
        setExpandedReports((prev) => new Set(prev).add(assistantMessageIndex));
        setReportSaveStates((prev) => ({ ...prev, [assistantMessageIndex]: 'idle' }));
      }
    } catch (error) {
      const errorText =
        error instanceof Error
          ? `I could not complete that request: ${error.message}`
          : 'I could not complete that request.';
      setMessages((prev) => [...prev, { role: 'assistant', text: errorText }]);
    } finally {
      setLoading(false);
    }
  }

  function toggleReport(index: number) {
    setExpandedReports((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleSaveReport(index: number, artifact: Artifact) {
    if (!user) return;
    setReportSaveStates((prev) => ({ ...prev, [index]: 'saving' }));
    const ok = await saveReport(artifact);
    setReportSaveStates((prev) => ({ ...prev, [index]: ok ? 'saved' : 'error' }));
  }

  function handleExportArtifact(artifact: Artifact) {
    const table = getReportTable(artifact.topic, artifact.data, artifact.chartType);
    const fileName = `${artifact.title.toLowerCase().replace(/\s+/g, '-')}.xlsx`;
    const base64 = buildXlsxBase64(table.headers, table.rows);
    triggerDownload(fileName, base64ToBlob(base64, XLSX_MIME_TYPE));
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/90 shadow-[0_22px_60px_rgb(15_23_42/12%)] ring-1 ring-slate-950/5 backdrop-blur">
      <div className="shrink-0 border-b border-slate-200/70 bg-white/70 px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold">
              {sessionTitle && sessionTitle !== 'New conversation' ? sessionTitle : 'Conversation'}
            </h2>
            <p className="text-sm text-slate-500">Ask a question, or ask for a report -- reports open inline below their reply.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {user ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleNewChat}>
                <Plus size={14} />
                New chat
              </Button>
            ) : !authLoading ? (
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-blue-200 hover:text-blue-700"
              >
                <LogIn size={12} />
                Sign in to save history
              </Link>
            ) : null}
            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              <Database size={11} className="mr-1 inline" />
              DB connected
            </span>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-auto bg-gradient-to-b from-slate-50/70 to-white p-5">
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={`${message.role}-${index}`} className="flex max-w-[76%] items-start justify-end gap-3 ml-auto">
              <div className="rounded-2xl rounded-tr-md bg-gradient-to-br from-blue-600 to-indigo-600 px-4 py-3 text-sm font-medium leading-6 text-white shadow-lg shadow-blue-600/20">
                {message.text}
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-md">
                <User size={16} />
              </div>
            </div>
          ) : (
            <div key={`${message.role}-${index}`} className="flex max-w-[86%] items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-md">
                <Sparkles size={16} />
              </div>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
                <p className="whitespace-pre-line">{message.text}</p>
                {Array.isArray(message.tablesUsed) && message.tablesUsed.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
                    <Database size={12} className="text-slate-400" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      Tables used:
                    </span>
                    {message.tablesUsed.map((table) => (
                      <span
                        key={table}
                        className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
                      >
                        {table}
                      </span>
                    ))}
                  </div>
                ) : null}

                {message.artifact ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      onClick={() => toggleReport(index)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"
                    >
                      <BarChart3 size={13} />
                      {expandedReports.has(index) ? 'Hide Report' : 'View Report'}
                      {expandedReports.has(index) ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>

                    {expandedReports.has(index) ? (
                      <div className="mt-3 space-y-3">
                        <ArtifactChartPicker
                          title={message.artifact.title}
                          topic={message.artifact.topic}
                          chartType={message.artifact.chartType}
                          data={message.artifact.data}
                        />
                        <div className="flex flex-wrap gap-2">
                          {user ? (
                            <Button
                              size="sm"
                              className="gap-2"
                              disabled={reportSaveStates[index] === 'saving' || reportSaveStates[index] === 'saved'}
                              onClick={() => handleSaveReport(index, message.artifact!)}
                            >
                              {reportSaveStates[index] === 'saved' ? <Check size={14} /> : <Save size={14} />}
                              {reportSaveStates[index] === 'saving'
                                ? 'Saving...'
                                : reportSaveStates[index] === 'saved'
                                  ? 'Saved'
                                  : reportSaveStates[index] === 'error'
                                    ? 'Save failed -- retry'
                                    : 'Save Report'}
                            </Button>
                          ) : (
                            <Link
                              href="/login"
                              className="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-3 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
                            >
                              Sign In To Save
                            </Link>
                          )}
                          {user ? (
                            <Link
                              href="/reports"
                              className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                            >
                              Saved Reports
                            </Link>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            onClick={() => handleExportArtifact(message.artifact!)}
                          >
                            <FileSpreadsheet size={14} />
                            Export Excel
                          </Button>
                        </div>
                        {reportSaveStates[index] !== 'saved' ? (
                          <p className="text-xs text-slate-400">This chart is not saved yet -- click Save Report to keep it.</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ),
        )}
        {loading ? (
          <div className="flex max-w-[76%] items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-md">
              <Sparkles size={16} />
            </div>
            <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-500 shadow-sm">
              Reading the database and preparing a grounded answer...
            </div>
          </div>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="shrink-0 border-t border-slate-200/80 bg-white/90 p-4">
        <div className="flex items-end gap-3 rounded-2xl border border-blue-200 bg-white p-3 shadow-[0_14px_34px_rgb(37_99_235/12%)] ring-4 ring-blue-50">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            className="max-h-32 min-h-16 flex-1 resize-none bg-transparent text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            placeholder="Ask anything about your ecommerce data..."
          />
          <Button
            type="submit"
            disabled={loading || !input.trim()}
            className="h-11 gap-2 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 px-5 font-semibold shadow-lg shadow-blue-600/20 hover:from-blue-700 hover:to-indigo-700"
          >
            <Send size={16} />
            {loading ? 'Working' : 'Ask'}
          </Button>
        </div>
      </form>
    </div>
  );
}
