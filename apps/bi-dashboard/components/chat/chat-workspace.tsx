'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BarChart3, Check, Database, FileSpreadsheet, LogIn, Plus, Save, Send, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/auth/auth-provider';
import { getReportTable } from '@/lib/dashboard/report-table';
import { XLSX_MIME_TYPE, base64ToBlob, buildXlsxBase64, triggerDownload } from '@/lib/download';
import type { ChatResponse, DashboardData } from '@/lib/dashboard/metrics';

type Message = {
  role: 'user' | 'assistant';
  text: string;
  tablesUsed?: string[];
};

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

const WELCOME_MESSAGE: Message = {
  role: 'assistant',
  text: 'Hi. Ask about billing, collections, POPs, active customers, or support tickets, or request a report.',
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
// in the report panel) -- it never happens automatically just because a
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

export function ChatWorkspace({ initialData = null }: { initialData?: DashboardData | null }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');

  // FIX 2026-09-17: previously the ONLY source of this data was the
  // `initialData` prop, fetched server-side in app/chat/page.tsx BEFORE the
  // page was allowed to render at all -- see that file's comment. Fetched
  // here instead, after mount, so it never blocks the chat UI itself from
  // appearing; it's only read later, when a message is actually sent (see
  // activeData below), by which point this same-origin fetch has almost
  // always already resolved.
  const [homeData, setHomeData] = useState<DashboardData | null>(initialData);
  useEffect(() => {
    if (homeData) return;
    let cancelled = false;
    // PERF FIX 2026-09-17: this only ever feeds kpi labels + static
    // chartSources + top-POP context (see activeData usage below) -- it
    // never needed package/customer/ticket/transaction-mode breakdowns.
    // topic=pops keeps that context real while skipping the full
    // 386k-customer aggregation and every other breakdown this page never
    // renders (see readonly-api.mjs/dashboard-data.mjs's own comments).
    fetch('/api/dashboard-data?topic=pops')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DashboardData | null) => {
        if (!cancelled && data) setHomeData(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // FIX 2026-09-15: the loading bubble below used to say the same fixed
  // sentence no matter how long a turn actually took -- a real compound
  // question (two metrics, a wide POP range) can genuinely take up to the
  // backend's own ~90s timeout (see readonly-api.mjs), and with no signal
  // that it was still working, that looked identical to "frozen/broken".
  // This escalates the message after 8s so a slow-but-working turn reads
  // as slow, not dead.
  const [slowRequest, setSlowRequest] = useState(false);
  const slowRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [reportSaveState, setReportSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const sessionSetupRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeData = artifact?.data ?? homeData;

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
    setArtifact(null);
    setReportSaveState('idle');
    setSessionId(null);
    setSessionTitle(null);
    sessionSetupRef.current = null;
    router.push('/chat');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || loading) return;

    setInput('');
    setLoading(true);
    setSlowRequest(false);
    if (slowRequestTimerRef.current) clearTimeout(slowRequestTimerRef.current);
    slowRequestTimerRef.current = setTimeout(() => setSlowRequest(true), 8_000);
    setMessages((prev) => [...prev, { role: 'user', text: message }]);
    const activeSessionId = await ensureSession(message);
    if (user && activeSessionId) {
      saveMessage(activeSessionId, 'user', message);
    }

    try {
      // Goes through this app's own /api/chat route, not the internal
      // backend directly -- that route enforces sign-in and rate limiting
      // before it ever reaches the backend. See app/api/chat/route.ts.
      const response = await fetch(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            history: messages.slice(-12).map((m) => ({ role: m.role, content: m.text })),
            page_state: {
              page: 'chat',
              days: artifact?.days ?? 30,
              region: artifact?.region ?? null,
              kpis: activeData?.kpis?.map((kpi) => kpi.label) ?? [],
              chartSources: activeData?.chartSources ?? null,
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        // The API returns { error: "..." } as JSON -- surface that message
        // directly instead of the raw JSON blob when we can parse it.
        let message = body || 'Chat request failed';
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // body wasn't JSON -- fall back to the raw text above.
        }
        throw new Error(message);
      }

      const result = (await response.json()) as ChatResponse;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: result.narrative, tablesUsed: result.tablesUsed },
      ]);
      if (user && activeSessionId) saveMessage(activeSessionId, 'assistant', result.narrative, result.tablesUsed);

      // A turn can come back with real, freshly-queried breakdown data even
      // when the report gate didn't call this a "create a report" request --
      // e.g. a correction like "i meant X" that answers a question about a
      // report already on screen, without using the word report/chart. If a
      // report panel is already showing, keep it in sync with whatever data
      // the assistant most recently and genuinely looked up, instead of
      // leaving it stuck on an older, now-mismatched breakdown (different
      // rows, different column count) while the text answer next to it is
      // current. Only an explicit create_new_page ever opens a NEW panel
      // that wasn't showing before -- a plain answer never spontaneously
      // pops one up.
      if (result.askedClarification) {
        // FIX 2026-09-17: a clarifying question means NOTHING was actually
        // looked up this turn -- leaving a previous report panel on screen
        // next to it silently implies that old, unrelated data (wrong
        // topic, wrong metrics) answers the new question the user hasn't
        // even gotten a chance to clarify yet (confirmed live: a package-
        // report clarifying question was shown next to a leftover POP
        // table). Clear the panel so a clarifying question always reads as
        // "no report yet" rather than "here's your report" with the wrong
        // one attached.
        setArtifact(null);
      } else if (result.data && (result.intent === 'create_new_page' || artifact)) {
        setArtifact({
          title: result.title,
          narrative: result.narrative,
          topic: result.topic ?? 'dashboard',
          chartType: result.chartType ?? 'bar',
          data: result.data,
          days: result.filters.days,
          region: result.filters.region,
          tablesUsed: result.tablesUsed,
        });
        setReportSaveState('idle');
      }
    } catch (error) {
      const errorText =
        error instanceof Error
          ? `I could not complete that request: ${error.message}`
          : 'I could not complete that request.';
      setMessages((prev) => [...prev, { role: 'assistant', text: errorText }]);
    } finally {
      if (slowRequestTimerRef.current) {
        clearTimeout(slowRequestTimerRef.current);
        slowRequestTimerRef.current = null;
      }
      setLoading(false);
      setSlowRequest(false);
    }
  }

  async function handleSaveReport() {
    if (!artifact || !user) return;
    setReportSaveState('saving');
    const ok = await saveReport(artifact);
    setReportSaveState(ok ? 'saved' : 'error');
  }

  function handleExportArtifact() {
    if (!artifact) return;
    const table = getReportTable(artifact.topic, artifact.data, artifact.chartType);
    const fileName = `${artifact.title.toLowerCase().replace(/\s+/g, '-')}.xlsx`;
    const base64 = buildXlsxBase64(table.headers, table.rows);
    triggerDownload(fileName, base64ToBlob(base64, XLSX_MIME_TYPE));
  }

  return (
    <div className="grid h-full min-h-0 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/90 shadow-[0_22px_60px_rgb(15_23_42/12%)] ring-1 ring-slate-950/5 backdrop-blur">
        <div className="shrink-0 border-b border-slate-200/70 bg-white/70 px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold">
                {sessionTitle && sessionTitle !== 'New conversation' ? sessionTitle : 'Conversation'}
              </h2>
              <p className="text-sm text-slate-500">Ask a question, or ask for a report or graph.</p>
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
              <div key={`${message.role}-${index}`} className="flex max-w-[76%] items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-md">
                  <Sparkles size={16} />
                </div>
                <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
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
                {slowRequest
                  ? 'Still working -- this question needs more than one real database lookup, so it is taking longer than usual (up to ~90s for a heavy or multi-part question).'
                  : 'Reading the database and preparing a grounded answer...'}
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
              placeholder="Ask anything about billing, collections, POPs, or tickets..."
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
      </section>

      <aside className="min-h-0 overflow-auto">
        {artifact ? (
          <section className="space-y-4 rounded-2xl border border-white/70 bg-white/90 p-5 shadow-[0_22px_60px_rgb(15_23_42/12%)] ring-1 ring-slate-950/5 backdrop-blur">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <BarChart3 size={18} className="text-teal-600" />
                <p className="font-semibold">{artifact.title}</p>
              </div>
              <p className="text-sm text-slate-500">{artifact.narrative}</p>
            </div>

            {(() => {
              const inlineTable = getReportTable(artifact.topic, artifact.data, artifact.chartType);
              return (
                <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white">
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          {inlineTable.headers.map((header, i) => (
                            <th key={`${header}-${i}`} className="px-3 py-2 font-semibold">{header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inlineTable.rows.length ? (
                          inlineTable.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j} className="px-3 py-2 text-slate-700">{cell}</td>
                              ))}
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={inlineTable.headers.length} className="px-3 py-6 text-center text-slate-400">
                              No data available for this view.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap gap-2">
              {user ? (
                <Button
                  size="sm"
                  className="gap-2"
                  disabled={reportSaveState === 'saving' || reportSaveState === 'saved'}
                  onClick={handleSaveReport}
                >
                  {reportSaveState === 'saved' ? <Check size={14} /> : <Save size={14} />}
                  {reportSaveState === 'saving'
                    ? 'Saving...'
                    : reportSaveState === 'saved'
                      ? 'Saved'
                      : reportSaveState === 'error'
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
              <Button variant="outline" size="sm" className="gap-2" onClick={handleExportArtifact}>
                <FileSpreadsheet size={14} />
                Export Excel
              </Button>
            </div>
            {reportSaveState !== 'saved' ? (
              <p className="text-xs text-slate-400">This chart is not saved yet -- click Save Report to keep it.</p>
            ) : null}
          </section>
        ) : (
          <section className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-white/60 p-8 text-center">
            <Sparkles size={20} className="text-slate-300" />
            <p className="text-sm text-slate-400">Ask for a chart or report and it will show up here.</p>
          </section>
        )}
      </aside>
    </div>
  );
}
