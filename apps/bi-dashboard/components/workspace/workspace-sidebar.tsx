'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Download,
  FileText,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MessageSquareText,
  MoreVertical,
  Pencil,
  Settings,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

// "Sessions" used to be its own nav item here -- removed per explicit
// request (not being worked on right now); the full transcript list it
// pointed to is still reachable via this same sidebar's "View all" link
// under Recent Chats, so nothing is actually lost, just one less top-level
// entry competing for space.
const navItems = [
  { label: 'Chat', href: '/chat', icon: MessageSquareText },
  { label: 'Reports', href: '/reports', icon: FileText },
  { label: 'Exports', href: '/exports', icon: Download },
  { label: 'Settings', href: '/settings', icon: Settings },
];

type RecentSession = {
  id: number;
  title: string;
  updated_at: string;
};

// FIX 2026-09-28: this used to group sessions into recency buckets
// (Today/Yesterday/Last 7 Days/Older) with each session's own timestamp
// shown as a relative "5d ago" label -- explicitly asked to be removed:
// no bucket headers, just each chat's real date, plain. Sessions are
// already returned newest-first by the API, so a flat list keeps that
// same real chronological order without any grouping on top of it.
function formatSessionTimestamp(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

// The actual sidebar UI (nav, dated/actionable Recent Chats, account) --
// rendered twice: once inside the always-visible desktop <aside>, and once
// inside the mobile hamburger's Sheet. Each mount fetches its own Recent
// Chats page independently (simplest correct option -- the mobile Sheet's
// copy is unmounted, so not fetched at all, until the user actually opens
// it).
function SidebarContent({ active, onNavigate }: { active: string; onNavigate?: () => void }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentChatSessionId = searchParams.get('session');
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
  // Which session's row is currently showing an inline rename input, and
  // its in-progress text -- only ever one at a time.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

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

  function startRename(session: RecentSession) {
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
    // Optimistic -- renamed instantly in the list; reverted below only if
    // the request actually fails, same pattern the row-delete below uses.
    const previous = recentSessions;
    setRecentSessions((prev) => (prev ? prev.map((s) => (s.id === id ? { ...s, title } : s)) : prev));
    try {
      const res = await fetch(`/api/chat-sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) setRecentSessions(previous);
    } catch {
      setRecentSessions(previous);
    }
  }

  async function handleDelete(session: RecentSession) {
    if (!confirm(`Delete "${session.title}"? This cannot be undone.`)) return;
    const previous = recentSessions;
    setRecentSessions((prev) => (prev ? prev.filter((s) => s.id !== session.id) : prev));
    setSessionsTotal((t) => Math.max(0, t - 1));
    try {
      const res = await fetch(`/api/chat-sessions/${session.id}`, { method: 'DELETE' });
      if (!res.ok) {
        setRecentSessions(previous);
        setSessionsTotal((t) => t + 1);
        return;
      }
      // Deleting the conversation currently open in the chat window --
      // leave it back at a blank chat rather than on a now-404ing session.
      if (currentChatSessionId === String(session.id)) {
        router.push('/chat');
      }
    } catch {
      setRecentSessions(previous);
      setSessionsTotal((t) => t + 1);
    }
  }

  const hasMoreSessions = (recentSessions?.length ?? 0) < sessionsTotal;

  return (
    <>
      <div className="sticky top-0 z-10 flex h-20 items-center gap-3 border-b border-slate-200/70 bg-white/90 px-5 backdrop-blur-xl">
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
                onClick={onNavigate}
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

        {user && recentSessions && recentSessions.length > 0 ? (
          <nav className="space-y-4 border-t border-slate-200 pt-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Recent Chats</p>
              <Link href="/sessions" onClick={onNavigate} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
                View all
              </Link>
            </div>
            <div className="space-y-1">
              {(recentSessions ?? []).map((session) => {
                  const isActiveSession = currentChatSessionId === String(session.id);
                  return renamingId === session.id ? (
                    <input
                      key={session.id}
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
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
                      className="block w-full truncate rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-2 ring-blue-100"
                    />
                  ) : (
                    <div
                      key={session.id}
                      className={`group flex items-center gap-1 rounded-lg pr-1 transition ${
                        isActiveSession
                          ? 'bg-white shadow-sm ring-1 ring-slate-200'
                          : 'hover:bg-white hover:shadow-sm'
                      }`}
                    >
                      <Link
                        href={`/chat?session=${session.id}`}
                        onClick={onNavigate}
                        className="block min-w-0 flex-1 px-3 py-2"
                        title={session.title}
                      >
                        <span
                          className={`block truncate text-sm font-medium leading-tight ${
                            isActiveSession ? 'text-slate-950' : 'text-slate-700 group-hover:text-slate-950'
                          }`}
                        >
                          {session.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-medium leading-tight text-slate-400">
                          {formatSessionTimestamp(session.updated_at)}
                        </span>
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`Options for ${session.title}`}
                              className="shrink-0 rounded-md p-1.5 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
                            />
                          }
                        >
                          <MoreVertical size={14} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onClick={() => startRename(session)}>
                            <Pencil size={14} />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => handleDelete(session)}>
                            <Trash2 size={14} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
              })}
            </div>
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
              onClick={onNavigate}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 hover:shadow-sm"
            >
              <LogIn size={15} className="text-slate-400" />
              Sign in / Create account
            </Link>
          )}
        </nav>
      </div>
    </>
  );
}

// Desktop: a permanently visible column. Unchanged behavior/appearance
// from before -- still hidden below the lg breakpoint, where
// MobileSidebarTrigger below takes over instead of leaving small screens
// with no way to reach this at all.
export function WorkspaceSidebar({ active }: { active: string }) {
  return (
    <aside className="hidden h-screen w-[280px] shrink-0 overflow-y-auto border-r border-white/70 bg-white/90 shadow-[10px_0_36px_rgb(15_23_42/8%)] backdrop-blur-xl lg:block">
      <SidebarContent active={active} />
    </aside>
  );
}

// Mobile/narrow-screen: previously this sidebar was simply `hidden` below
// lg with no substitute at all -- every nav item, Recent Chats, and
// account control was completely unreachable on a small screen. This is a
// single hamburger button (meant to sit at the top-left of the page
// header) that opens the exact same sidebar content in a slide-over
// panel instead.
export function MobileSidebarTrigger({ active }: { active: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" />}
      >
        <Menu size={20} />
      </SheetTrigger>
      <SheetContent side="left" className="w-[280px] overflow-y-auto p-0 sm:max-w-[280px]">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarContent active={active} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
