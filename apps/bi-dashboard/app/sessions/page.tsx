'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LogIn, MessageSquareText, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { useAuth } from '@/components/auth/auth-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // Which card is currently showing an inline rename input, and its
  // in-progress text -- same pattern as the sidebar's Recent Chats rename
  // (see workspace-sidebar.tsx), kept consistent across both places a
  // conversation can be renamed from.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // FIX 2026-09-17: standardized with /reports -- both list pages now show
  // 6 per page with the same page/total contract from their API route,
  // instead of Sessions loading every row in one unpaginated request.
  const pageSize = 6;

  const loadPage = useCallback((targetPage: number) => {
    setSessions(null);
    fetch(`/api/chat-sessions?page=${targetPage}`)
      .then((res) => res.json())
      .then((body: { sessions: SessionRow[]; total: number; page: number }) => {
        setSessions(body.sessions);
        setTotal(body.total);
        setPage(body.page);
      })
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    loadPage(1);
  }, [authLoading, user, loadPage]);

  async function handleDeleteById(id: number) {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    await fetch(`/api/chat-sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    const remainingOnPage = (sessions?.length ?? 1) - 1;
    const nextPage = remainingOnPage === 0 && page > 1 ? page - 1 : page;
    loadPage(nextPage);
  }

  function startRename(session: SessionRow) {
    setRenamingId(session.id);
    setRenameValue(session.title);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue('');
  }

  async function commitRename(id: number) {
    const title = renameValue.trim();
    cancelRename();
    if (!title) return;
    // Optimistic -- same pattern as the sidebar's rename: updates the card
    // instantly, only reverted if the request actually fails.
    setSessions((prev) => (prev ? prev.map((s) => (s.id === id ? { ...s, title } : s)) : prev));
    const res = await fetch(`/api/chat-sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    if (!res || !res.ok) loadPage(page);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <WorkspacePage active="Sessions" title="Sessions" subtitle="Your saved conversations. Reopen any of them to keep chatting." scroll>
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
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={`/sessions/${session.id}`}
                className="group rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgb(15_23_42/10%)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <MessageSquareText size={18} className="shrink-0 text-blue-600" />
                    {renamingId === session.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.preventDefault()}
                        onBlur={() => commitRename(session.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename(session.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        className="min-w-0 flex-1 rounded-md border border-blue-300 bg-white px-2 py-1 font-bold text-slate-950 outline-none ring-2 ring-blue-100"
                      />
                    ) : (
                      <h2 className="min-w-0 flex-1 truncate font-bold text-slate-950">{session.title}</h2>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          onClick={(e) => e.preventDefault()}
                          aria-label={`Options for ${session.title}`}
                          className="shrink-0 rounded-md p-1.5 text-slate-300 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
                        />
                      }
                    >
                      <MoreVertical size={16} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => startRename(session)}>
                        <Pencil size={14} />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => handleDeleteById(session.id)}>
                        <Trash2 size={14} />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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

          {totalPages > 1 ? (
            <div className="mt-6 mb-2 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => loadPage(page - 1)}
                disabled={page <= 1}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => loadPage(page + 1)}
                disabled={page >= totalPages}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
        </>
      )}
    </WorkspacePage>
  );
}
