'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LogIn, MessageSquareText, Trash2 } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { useAuth } from '@/components/auth/auth-provider';

type SessionRow = {
  id: number;
  title: string;
  message_count: number;
  last_question: string | null;
  last_answer: string | null;
  created_at: string;
  updated_at: string;
};

export default function SessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);

  function loadSessions() {
    fetch('/api/chat-sessions')
      .then((res) => res.json())
      .then((body: { sessions: SessionRow[] }) => setSessions(body.sessions))
      .catch(() => setSessions([]));
  }

  useEffect(() => {
    if (authLoading || !user) return;
    loadSessions();
  }, [authLoading, user]);

  async function handleDelete(id: number, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    await fetch(`/api/chat-sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    loadSessions();
  }

  return (
    <WorkspacePage active="Sessions" title="Sessions" subtitle="Your saved conversations. Reopen any of them to keep chatting.">
      {!authLoading && !user ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <LogIn size={22} className="text-slate-400" />
          <p className="text-sm text-slate-500">Sign in to see your saved conversations.</p>
          <Link href="/login" className="text-sm font-semibold text-blue-600 hover:underline">
            Sign in / Create account
          </Link>
        </div>
      ) : sessions === null ? (
        <p className="text-sm text-slate-500">Loading your conversations...</p>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-slate-500">
            No conversations yet. Start one in{' '}
            <Link href="/chat" className="font-semibold text-blue-600 hover:underline">
              Chat
            </Link>{' '}
            and it will show up here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sessions.map((session) => (
            <Link
              key={session.id}
              href={`/sessions/${session.id}`}
              className="group rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgb(15_23_42/10%)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <MessageSquareText size={18} className="shrink-0 text-blue-600" />
                  <h2 className="font-bold text-slate-950">{session.title}</h2>
                </div>
                <button
                  type="button"
                  onClick={(event) => handleDelete(session.id, event)}
                  className="shrink-0 rounded-md p-1.5 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                  aria-label="Delete conversation"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {session.last_question ? (
                <div className="mt-3 space-y-1.5 text-sm">
                  <p className="truncate text-slate-500">
                    <span className="font-semibold text-slate-400">You: </span>
                    {session.last_question}
                  </p>
                  {session.last_answer ? (
                    <p className="line-clamp-2 text-slate-600">
                      <span className="font-semibold text-slate-400">Assistant: </span>
                      {session.last_answer}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-400">No messages yet.</p>
              )}

              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {session.message_count} message{session.message_count === 1 ? '' : 's'}
                </span>
                <span>{new Date(session.updated_at).toLocaleString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </WorkspacePage>
  );
}
