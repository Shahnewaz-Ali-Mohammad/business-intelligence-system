'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export const LAST_WORKSPACE_KEY = 'bi:lastWorkspace';

/**
 * Where "Chat" goes when no conversation is named: the last workspace the
 * person used, otherwise the first workspace with a database. The original
 * workspace is never chosen automatically; it opens only from its own link.
 */
export function ChatLanding() {
  const router = useRouter();
  const [message, setMessage] = useState('Opening your workspace…');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((body: { workspaces?: { id: string; databases?: { id: string }[] }[] }) => {
        if (cancelled) return;
        const usable = (body.workspaces || []).filter((w) => w.id !== 'isp-default' && w.databases?.length);
        let last: string | null = null;
        try { last = localStorage.getItem(LAST_WORKSPACE_KEY); } catch {}
        const target = usable.find((w) => w.id === last) || usable[0];
        if (!target) { setMessage('No workspaces yet. Ask your admin to connect a database.'); return; }
        router.replace(`/data-sources/${encodeURIComponent(target.id)}/chat?source=${encodeURIComponent(target.databases![0].id)}`);
      })
      .catch(() => { if (!cancelled) setMessage('Could not load your workspaces.'); });
    return () => { cancelled = true; };
  }, [router]);
  return <div className="flex h-full items-center justify-center text-sm text-zinc-500">{message}</div>;
}
