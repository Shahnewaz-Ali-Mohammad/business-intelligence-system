'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUp, Database, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';

type ChatMessageRow = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tables_used: string[] | null;
  created_at: string;
  report_data?: { workspaceToolAnswer?: unknown } | null;
};

type SessionRow = { id: number; title: string; created_at: string; updated_at: string; warehouse_id?: string | null };

const PAGE_SIZE = 10; // 5 exchanges per page (question + answer each)

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionRow | null | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    fetch(`/api/chat-sessions/${params.id}?limit=${PAGE_SIZE}`)
      .then((res) => res.json())
      .then((body: { session: SessionRow | null; messages: ChatMessageRow[]; hasMore: boolean }) => {
        setSession(body.session);
        setMessages(body.messages ?? []);
        setHasMore(body.hasMore ?? false);
      })
      .catch(() => setSession(null));
  }, [params.id]);

  async function loadOlder() {
    if (!messages.length || loadingMore) return;
    setLoadingMore(true);
    try {
      const oldestId = messages[0].id;
      const res = await fetch(`/api/chat-sessions/${params.id}?limit=${PAGE_SIZE}&beforeId=${oldestId}`);
      const body = (await res.json()) as { messages: ChatMessageRow[]; hasMore: boolean };
      setMessages((prev) => [...(body.messages ?? []), ...prev]);
      setHasMore(body.hasMore ?? false);
    } finally {
      setLoadingMore(false);
    }
  }

  // Pair each user message with the assistant reply that immediately follows it,
  // so the transcript reads as a list of exchanges rather than a flat log.
  const exchanges: Array<{ question?: ChatMessageRow; answer?: ChatMessageRow }> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      exchanges.push({ question: message });
    } else if (exchanges.length && !exchanges[exchanges.length - 1].answer) {
      exchanges[exchanges.length - 1].answer = message;
    } else {
      exchanges.push({ answer: message });
    }
  }

  if (session === undefined) {
    return (
      <WorkspacePage active="Sessions" title="Loading conversation..." subtitle="">
        <p className="text-sm text-zinc-500">Loading...</p>
      </WorkspacePage>
    );
  }

  if (session === null) {
    return (
      <WorkspacePage active="Sessions" title="Conversation not found" subtitle="">
        <p className="text-sm text-zinc-500">
          This conversation does not exist, or belongs to a different account.
        </p>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      active="Sessions"
      title={session.title}
      subtitle={`Started ${new Date(session.created_at).toLocaleString()}`}
      action={
        <Link href={session.warehouse_id && messages.some((m) => m.report_data?.workspaceToolAnswer) ? `/data-sources/${encodeURIComponent(session.warehouse_id)}/chat?session=${session.id}` : `/chat?session=${session.id}`}>
          <Button className="gap-2 bg-rose-700 hover:bg-rose-800">
            Continue this conversation
            <ArrowRight size={16} />
          </Button>
        </Link>
      }
    >
      <div className="mx-auto max-h-[75vh] max-w-3xl space-y-6 overflow-y-auto pr-1">
        {hasMore ? (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" className="gap-2" onClick={loadOlder} disabled={loadingMore}>
              <ArrowUp size={14} />
              {loadingMore ? 'Loading...' : 'Load older messages'}
            </Button>
          </div>
        ) : null}

        {exchanges.map((exchange, index) => (
          <section
            key={exchange.question?.id ?? exchange.answer?.id ?? index}
            className="space-y-3 rounded-lg border border-zinc-200/80 bg-white p-5 shadow-sm"
          >
            {exchange.question ? (
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-100 text-zinc-600">
                  <User size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">You</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm text-zinc-800">{exchange.question.content}</p>
                </div>
              </div>
            ) : null}
            {exchange.answer ? (
              <div className="flex items-start gap-3 border-t border-zinc-100 pt-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
                  <Sparkles size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Assistant</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm text-zinc-700">{exchange.answer.content}</p>
                  {exchange.answer.tables_used && exchange.answer.tables_used.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Database size={11} className="text-zinc-400" />
                      {exchange.answer.tables_used.map((table) => (
                        <span
                          key={table}
                          className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600"
                        >
                          {table}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </WorkspacePage>
  );
}
