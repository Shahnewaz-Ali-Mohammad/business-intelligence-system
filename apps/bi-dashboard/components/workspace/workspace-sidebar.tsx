'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Download,
  FileText,
  LayoutDashboard,
  LogIn,
  LogOut,
  MessageSquareText,
  Settings,
} from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';

const navItems = [
  { label: 'Chat', href: '/chat', icon: MessageSquareText },
  { label: 'Sessions', href: '/sessions', icon: LayoutDashboard },
  { label: 'Reports', href: '/reports', icon: FileText },
  { label: 'Exports', href: '/exports', icon: Download },
  { label: 'Settings', href: '/settings', icon: Settings },
];

type RecentSession = {
  id: number;
  title: string;
  updated_at: string;
};

// Groups the same real chat_sessions rows the /sessions page already lists
// (title + updated_at, nothing invented) into recency buckets -- Today,
// Yesterday, Last 7 Days, Older -- so the sidebar reads as a real dated
// history instead of a flat, unordered list. Pure date-arithmetic, no
// text parsing of any kind.
function bucketSessions(sessions: RecentSession[]) {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const weekAgo = today - 7 * 86_400_000;

  const buckets: { label: string; sessions: RecentSession[] }[] = [
    { label: 'Today', sessions: [] },
    { label: 'Yesterday', sessions: [] },
    { label: 'Last 7 Days', sessions: [] },
    { label: 'Older', sessions: [] },
  ];

  for (const session of sessions) {
    const updatedAt = startOfDay(new Date(session.updated_at));
    if (updatedAt >= today) buckets[0].sessions.push(session);
    else if (updatedAt >= yesterday) buckets[1].sessions.push(session);
    else if (updatedAt >= weekAgo) buckets[2].sessions.push(session);
    else buckets[3].sessions.push(session);
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

export function WorkspaceSidebar({ active }: { active: string }) {
  const { user, loading, logout } = useAuth();
  const [recentSessions, setRecentSessions] = useState<RecentSession[] | null>(null);
  // FIX 2026-09-28: this used to fetch page 1 once and stop -- with 6
  // sessions a page, anything past the 6 most recently updated chats was
  // only reachable via the separate /sessions page, with no way to see
  // more right here. Tracks its own page/total (same page/total contract
  // /api/chat-sessions already returns for the full Sessions page) so a
  // "Load more" click can append the next page onto this same list in
  // place, same behavior as scrolling further down a real chat history
  // list.
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  function fetchSessionsPage(page: number) {
    return fetch(`/api/chat-sessions?page=${page}`).then(
      (res) => res.json() as Promise<{ sessions: RecentSession[]; total: number; page: number }>,
    );
  }

  function handleLoadMore() {
    setLoadingMore(true);
    fetchSessionsPage(sessionsPage + 1)
      .then((body) => {
        setRecentSessions((prev) => [...(prev ?? []), ...(body.sessions ?? [])]);
        setSessionsTotal(body.total ?? 0);
        setSessionsPage(body.page ?? sessionsPage + 1);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  function refreshFromPageOne() {
    fetchSessionsPage(1)
      .then((body) => {
        setRecentSessions(body.sessions ?? []);
        setSessionsTotal(body.total ?? 0);
        setSessionsPage(body.page ?? 1);
      })
      .catch(() => setRecentSessions([]));
  }

  useEffect(() => {
    // No signed-out branch here calling setState -- any stale data from a
    // previous signed-in session simply never renders once signed out,
    // since the render below already requires `user` to be truthy before
    // showing this section at all. This effect's own setState calls all
    // happen inside the fetch's .then/.catch (async), never synchronously
    // in the effect body itself.
    if (!user) return;
    refreshFromPageOne();
    // refreshFromPageOne is a plain function recreated every render (not
    // memoized) -- listing it as a dep would refire this effect every
    // render, not just when `user` actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    // The chat workspace fires this the moment a brand-new conversation's
    // first exchange is actually saved (see chat-workspace.tsx) -- without
    // it, a chat started in THIS tab only ever appeared here after a full
    // page reload, since nothing else tells this sidebar its list is now
    // stale. Resets back to page 1 (the newest conversation always lands
    // there) rather than trying to merge it into whatever page count was
    // previously loaded.
    if (!user) return;
    function handleSessionCreated() {
      refreshFromPageOne();
    }
    window.addEventListener('bi:chat-session-created', handleSessionCreated);
    return () => window.removeEventListener('bi:chat-session-created', handleSessionCreated);
    // Same reasoning as the effect above -- refreshFromPageOne is a plain,
    // non-memoized function; only `user` should re-subscribe this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const buckets = recentSessions ? bucketSessions(recentSessions) : [];
  const hasMoreSessions = (recentSessions?.length ?? 0) < sessionsTotal;

  return (
    <aside className="hidden h-screen w-[280px] shrink-0 overflow-y-auto border-r border-white/70 bg-white/90 shadow-[10px_0_36px_rgb(15_23_42/8%)] backdrop-blur-xl lg:block">
      <div className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-slate-200/70 bg-white/90 px-5 backdrop-blur-xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-slate-950 to-blue-950 text-white shadow-lg shadow-slate-950/20">
          <LayoutDashboard size={19} />
        </div>
        <div>
          <p className="text-sm font-bold text-slate-950">Business Intelligence</p>
          <p className="text-xs text-slate-500">Read-only analytics</p>
        </div>
      </div>

      <div className="space-y-5 px-3.5 py-5">
        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const selected = active === item.label;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold transition ${
                  selected
                    ? 'border border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-700 shadow-sm shadow-blue-950/5'
                    : 'text-slate-600 hover:bg-white hover:text-slate-950 hover:shadow-sm'
                }`}
              >
                <Icon size={17} className={selected ? 'text-blue-600' : 'text-slate-400'} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {user && buckets.length > 0 ? (
          <nav className="space-y-4 border-t border-slate-200 pt-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Recent Chats</p>
              <Link href="/sessions" className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
                View all
              </Link>
            </div>
            {buckets.map((bucket) => (
              <div key={bucket.label} className="space-y-1">
                <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {bucket.label}
                </p>
                {bucket.sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/chat?session=${session.id}`}
                    className="block truncate rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-white hover:text-slate-950 hover:shadow-sm"
                    title={session.title}
                  >
                    {session.title}
                  </Link>
                ))}
              </div>
            ))}
            {hasMoreSessions ? (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full rounded-lg px-3 py-2 text-center text-xs font-semibold text-blue-600 transition hover:bg-white hover:text-blue-700 disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            ) : null}
          </nav>
        ) : null}

        <nav className="space-y-2 border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Account</p>
          </div>
          {loading ? null : user ? (
            <div className="space-y-2 px-1">
              <div className="rounded-lg bg-white px-3 py-2.5 text-sm shadow-sm">
                <p className="truncate font-semibold text-slate-800">{user.displayName || user.email}</p>
                <p className="truncate text-xs text-slate-400">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 hover:shadow-sm"
              >
                <LogOut size={15} className="text-slate-400" />
                Sign out
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 hover:shadow-sm"
            >
              <LogIn size={15} className="text-slate-400" />
              Sign in / Create account
            </Link>
          )}
        </nav>
      </div>
    </aside>
  );
}
