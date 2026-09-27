'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Download,
  FileText,
  Home,
  LayoutDashboard,
  LogIn,
  LogOut,
  MessageSquareText,
  Settings,
} from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';

const navItems = [
  { label: 'Home', href: '/', icon: Home },
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

  useEffect(() => {
    // No signed-out branch here calling setState -- any stale data from a
    // previous signed-in session simply never renders once signed out,
    // since the render below already requires `user` to be truthy before
    // showing this section at all. Avoids a synchronous setState directly
    // in the effect body for a case the render already guards against.
    if (!user) return;
    fetch('/api/chat-sessions?page=1')
      .then((res) => res.json())
      .then((body: { sessions: RecentSession[] }) => setRecentSessions(body.sessions ?? []))
      .catch(() => setRecentSessions([]));
  }, [user]);

  const buckets = recentSessions ? bucketSessions(recentSessions) : [];

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
