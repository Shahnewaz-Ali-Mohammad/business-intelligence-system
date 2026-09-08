'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BarChart3, Database, FileSpreadsheet, LogIn, Plus, Send, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RegionRevenueChart } from '@/components/dashboard/charts/region-revenue-chart';
import { StatusDonutChart } from '@/components/dashboard/charts/status-donut-chart';
import { TopEntitiesBarChart } from '@/components/dashboard/charts/top-entities-bar-chart';
import { useAuth } from '@/components/auth/auth-provider';
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
  data: DashboardData;
  days: number;
  region: string | null;
  tablesUsed: string[];
};

const WELCOME_MESSAGE: Message = {
  role: 'assistant',
  text: 'Hi. Ask about revenue, orders, regions, products, or request a report from the ecommerce DB.',
};

// Picks which generated chart to show based on the topic the chatbot
// actually answered about, instead of always defaulting to region revenue --
// so "give me top customers" -> "generate a graph" renders a customers
// chart, not an unrelated one.
function ArtifactChart({ artifact }: { artifact: Artifact }) {
  const { topic, data } = artifact;

  if (topic === 'customers') {
    return (
      <TopEntitiesBarChart
        title="Top Customers by Orders"
        subtitle="users.id + orders (last window)"
        entries={data.topCustomersByOrders.map((row) => ({ name: row.name, value: row.orders }))}
        valueFormatter={(value) => `${value.toLocaleString('en-US')} orders`}
      />
    );
  }

  if (topic === 'products') {
    return (
      <TopEntitiesBarChart
        title="Top Products by Revenue"
        subtitle={data.chartSources.products}
        entries={data.topProductsChart.map((row) => ({ name: row.name, value: row.revenue }))}
        valueFormatter={(value) => `$${value.toLocaleString('en-US')}`}
      />
    );
  }

  if (topic === 'status' || topic === 'shipping') {
    return <StatusDonutChart data={data} />;
  }

  return <RegionRevenueChart data={data} />;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

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

function saveReport(artifact: Artifact) {
  fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: artifact.title,
      narrative: artifact.narrative,
      filters: { days: artifact.days, region: artifact.region },
      tablesUsed: artifact.tablesUsed,
      data: artifact.data,
    }),
  }).catch(() => {});
}

export function ChatWorkspace({ initialData }: { initialData: DashboardData }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSessionId = searchParams.get('session');

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const sessionSetupRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeData = artifact?.data ?? initialData;
  const regionOptions = useMemo(
    () => Array.from(new Set(initialData.regionRevenue.map((row) => row.region))),
    [initialData.regionRevenue],
  );

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

  // Lazily creates a session row for this conversation on its very first
  // message, so opening /chat never writes an empty "New conversation" row.
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
              days: artifact?.days ?? 30,
              region: artifact?.region ?? null,
              availableRegions: regionOptions,
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
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: result.narrative, tablesUsed: result.tablesUsed },
      ]);
      if (user && activeSessionId) saveMessage(activeSessionId, 'assistant', result.narrative, result.tablesUsed);

      if (result.data && result.intent === 'create_new_page') {
        const nextArtifact: Artifact = {
          title: result.title,
          narrative: result.narrative,
          topic: result.topic ?? 'dashboard',
          data: result.data,
          days: result.filters.days,
          region: result.filters.region,
          tablesUsed: result.tablesUsed,
        };
        setArtifact(nextArtifact);
        if (user) saveReport(nextArtifact);
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

  function handleExportArtifact() {
    const data = artifact?.data ?? initialData;
    downloadCsv(`generated-report-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Metric', 'Value', 'Detail'],
      ...data.kpis.map((kpi) => [kpi.label, kpi.value, kpi.detail]),
      [],
      ['Top Product', 'Revenue', 'Share', 'Units', 'AOV', 'Source'],
      ...data.topProducts,
    ]);
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
              <p className="text-sm text-slate-500">Answers stay here. Reports become saved artifacts.</p>
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
      </section>

      <aside className="min-h-0 space-y-4 overflow-auto">
        <section className="rounded-2xl border border-white/70 bg-white/90 p-5 shadow-[0_22px_60px_rgb(15_23_42/12%)] ring-1 ring-slate-950/5 backdrop-blur">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-cyan-50 text-blue-600 shadow-sm">
              <Sparkles size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold">Generated Artifact</h2>
              <p className="text-xs text-slate-500">
                {artifact ? 'Created from this session' : 'Ask for a graph or report'}
              </p>
            </div>
          </div>

          {artifact ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-inner">
                <BarChart3 size={20} className="mb-3 text-teal-600" />
                <p className="font-semibold">{artifact.title}</p>
                <p className="mt-1 text-sm text-slate-500">{artifact.narrative}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href="/reports"
                    className="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-3 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
                  >
                    {user ? 'View Saved Reports' : 'Sign In To Save'}
                  </Link>
                  <Button variant="outline" size="sm" className="gap-2" onClick={handleExportArtifact}>
                    <FileSpreadsheet size={14} />
                    CSV
                  </Button>
                </div>
              </div>
              <ArtifactChart artifact={artifact} />
            </div>
          ) : (
            <div className="space-y-2">
              {['Generate revenue report', 'Compare regions', 'Show product performance graph'].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                >
                  {prompt}
                  <Send size={14} className="text-blue-600" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/70 bg-white/90 p-5 shadow-[0_22px_60px_rgb(15_23_42/12%)] ring-1 ring-slate-950/5 backdrop-blur">
          <h2 className="text-base font-bold">Session Context</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {[
              artifact ? `${artifact.days} days` : 'Last 30 days',
              artifact?.region ?? 'All regions',
              ...(artifact?.tablesUsed ?? ['orders']),
            ].map((chip) => (
              <span key={chip} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">
                {chip}
              </span>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-700">
            <Database size={14} className="mr-1 inline" />
            Source: ecommerce read-only DB
          </div>
          {user ? (
            <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs font-semibold text-blue-700">
              Signed in as {user.email} -- this conversation is being saved and can be reopened from Sessions.
            </div>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
