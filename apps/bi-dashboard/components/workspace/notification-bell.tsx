'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCircle2, XCircle } from 'lucide-react';

type Notification = { id: string; title: string; message: string; reportId: number | null; status: 'success' | 'error' | string; createdAt: number; read: boolean };

const timeAgo = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleString();
};

/** Bell with unread count; lists scheduled-report notifications. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      setItems(data.items || []); setUnread(data.unread || 0);
    } catch { /* offline: keep the last list */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 60000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !popup.current?.contains(target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function toggle() {
    const next = !open;
    // The list opens in a layer above the page, next to the bell, so the
    // sidebar's own scrolling area never clips it.
    const rect = panel.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
    setOpen(next);
    if (next && unread) {
      setUnread(0);
      await fetch('/api/notifications', { method: 'POST' }).catch(() => {});
    }
  }

  return (
    <div ref={panel} className="relative ml-auto">
      <button type="button" onClick={toggle} aria-label={unread ? `${unread} new notifications` : 'Notifications'} title="Notifications" className="relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100">
        <Bell size={18} />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && createPortal(
        <div ref={popup} role="dialog" aria-label="Notifications" style={{ top: position.top, left: position.left }} className="fixed z-[100] w-80 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg">
          <p className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-800">Notifications</p>
          <div className="max-h-96 overflow-auto">
            {items.length === 0 && <p className="px-4 py-6 text-center text-sm text-zinc-500">No notifications yet. Scheduled reports appear here when they finish.</p>}
            {items.map((item) => {
              const Icon = item.status === 'error' ? XCircle : CheckCircle2;
              const body = (
                <div className={`flex gap-3 px-4 py-3 ${item.read ? '' : 'bg-rose-50/50'}`}>
                  <Icon size={16} className={`mt-0.5 shrink-0 ${item.status === 'error' ? 'text-red-600' : 'text-emerald-600'}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-800">{item.title}</p>
                    {item.message && <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{item.message}</p>}
                    <p className="mt-1 text-[11px] text-zinc-400">{timeAgo(item.createdAt)}</p>
                  </div>
                </div>
              );
              return item.reportId
                ? <Link key={item.id} href={`/reports/${item.reportId}`} onClick={() => setOpen(false)} className="block border-b border-zinc-100 hover:bg-zinc-50">{body}</Link>
                : <div key={item.id} className="border-b border-zinc-100">{body}</div>;
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
