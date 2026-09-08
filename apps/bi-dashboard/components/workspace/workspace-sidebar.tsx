'use client';

import Link from 'next/link';
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

export function WorkspaceSidebar({ active }: { active: string }) {
  const { user, loading, logout } = useAuth();
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
