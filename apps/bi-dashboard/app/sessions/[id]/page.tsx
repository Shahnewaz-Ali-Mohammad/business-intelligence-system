'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, Database, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspacePage } from '@/components/workspace/workspace-page';

type ChatMessageRow = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tables_used: string[] | null;
  created_at: string;
};

type SessionRow = { id: number; title: string; created_at: string; updated_at: string };

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionRow | null | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);

  useEffect(() => {
    fetch(`/api/chat-sessions/${params.id}`)
      .then((res) => res.json())
      .then((body: { session: SessionRow | null; messages: ChatMessageRow[] }) => {
        setSession(body.session);
        setMessages(body.messages ?? []);
      })
      .catch(() => setSession(null));
  }, [params.id]);

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
        <p className="text-sm text-slate-500">Loading...</p>
      </WorkspacePage>
    );
  }

  if (session === null) {
    return (
      <WorkspacePage active="Sessions" title="Conversation not found" subtitle="">
        <p className="text-sm text-slate-500">
          This conversation does not exist, or belongs to a different account.
        </p>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      active="Sessions"
      title={session.title}
      subtitle={`${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'} · started ${new Date(session.created_at).toLocaleString()}`}
      action={
        <Link href={`/chat?session=${session.id}`}>
          <Button className="gap-2 bg-blue-600 hover:bg-blue-700">
            Continue this conversation
            <ArrowRight size={16} />
          </Button>
        </Link>
      }
    >
      <div className="mx-auto max-w-3xl space-y-6">
        {exchanges.map((exchange, index) => (
          <section
            key={index}
            className="space-y-3 rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]"
          >
            {exchange.question ? (
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-white">
                  <User size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">You</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm text-slate-800">{exchange.question.content}</p>
                </div>
              </div>
            ) : null}
            {exchange.answer ? (
              <div className="flex items-start gap-3 border-t border-slate-100 pt-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
                  <Sparkles size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Assistant</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm text-slate-700">{exchange.answer.content}</p>
                  {exchange.answer.tables_used && exchange.answer.tables_used.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Database size={11} className="text-slate-400" />
                      {exchange.answer.tables_used.map((table) => (
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
            ) : null}
          </section>
        ))}
      </div>
    </WorkspacePage>
  );
}
