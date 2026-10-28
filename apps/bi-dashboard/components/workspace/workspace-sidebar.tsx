'use client';

import Link from 'next/link';
import { NotificationBell } from './notification-bell';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Download,
  FileText,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MessageSquareText,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Sparkles,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth, can } from '@/components/auth/auth-provider';
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
  { label: 'Design report', href: '', icon: Sparkles, permission: 'chat.use' },
  { label: 'Settings', href: '/data-sources', icon: Settings, permission: 'setup.manage' },
  { label: 'Admin', href: '/admin', icon: ShieldCheck, permission: 'users.manage' },
] as { label: string; href: string; icon: typeof Settings; permission?: string }[];

type RecentSession = {
  warehouse_id?: string | null;
  tool_chat?: number;
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [designs, setDesigns] = useState<{ id: number; title: string; workspaceId: string; blocks: number }[] | null>(null);
  const [lastWorkspace] = useState(() => { try { return typeof window === 'undefined' ? '' : localStorage.getItem('bi:lastWorkspace') || ''; } catch { return ''; } });
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch('/api/designs').then((r) => r.json()).then((d) => { if (!cancelled) setDesigns(d.designs || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [user, pathname]);
  const [workspaceList, setWorkspaceList] = useState<{ userId: number; rows: { id: string; name: string; databases?: { id: string; name: string }[] }[]; error?: string } | null>(null);
  const currentChatSessionId = searchParams.get('session');
  // The original workspace is current only when it is actually open (never a default).
  const currentWorkspaceId = pathname.match(/^\/data-sources\/([^/]+)/)?.[1] || searchParams.get('workspace') || (pathname === '/chat' && (searchParams.get('original') || searchParams.get('session')) ? 'isp-default' : '');
  const currentSourceId = searchParams.get('source');
  const scope = new URLSearchParams();
  if (currentWorkspaceId) scope.set('workspace', currentWorkspaceId);
  if (currentWorkspaceId && currentSourceId) scope.set('source', currentSourceId);
  const scopeQuery = scope.toString();
  const scopeRef = useRef(scopeQuery);
  useEffect(() => { scopeRef.current = scopeQuery; }, [scopeQuery]);
  const [sessionsScope, setSessionsScope] = useState(scopeQuery);
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
  const [renamingWorkspace,setRenamingWorkspace]=useState<string|null>(null);
  const [workspaceName,setWorkspaceName]=useState('');
  const [workspaceRenameError,setWorkspaceRenameError]=useState('');
  const [workspaceSaving,setWorkspaceSaving]=useState(false);
  async function saveWorkspaceName(workspaceId:string){
    const name=workspaceName.trim();if(!name||workspaceSaving)return;
    setWorkspaceSaving(true);setWorkspaceRenameError('');
    try{
      const response=await fetch(`/api/workspaces/${workspaceId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not rename workspace.');
      setWorkspaceList(current=>current?{...current,rows:current.rows.map(w=>w.id===workspaceId?{...w,name}:w)}:current);
      setRenamingWorkspace(null);window.dispatchEvent(new Event('bi:workspaces-changed'));
    }catch(error){setWorkspaceRenameError(error instanceof Error?error.message:'Could not rename workspace.');}
    finally{setWorkspaceSaving(false);}
  }

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const controller = new AbortController();
    async function refreshWorkspaces() {
      try {
        const res = await fetch('/api/workspaces', { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error('Could not load workspaces.');
        if (!cancelled) setWorkspaceList({ userId: user!.id, rows: body.workspaces || [] });
      } catch {
        if (!cancelled) setWorkspaceList({ userId: user!.id, rows: [], error: 'Could not load workspaces.' });
      }
    }
    refreshWorkspaces();
    window.addEventListener('bi:workspaces-changed', refreshWorkspaces);
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener('bi:workspaces-changed', refreshWorkspaces);
    };
  }, [user, pathname]);

  function fetchSessionsPage(page: number) {
    return fetch(`/api/chat-sessions?page=${page}&${scopeQuery}`).then(
      (res) => res.json() as Promise<{ sessions: RecentSession[]; total: number; page: number }>,
    );
  }

  function handleLoadMore() {
    setLoadingMore(true);
    fetchSessionsPage(sessionsPage + 1)
      .then((body) => {
        if (scopeRef.current !== scopeQuery) return;
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
        if (scopeRef.current !== scopeQuery) return;
        setRecentSessions(body.sessions ?? []);
        setSessionsScope(scopeQuery);
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
  }, [user, scopeQuery]);

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
  }, [user, scopeQuery]);

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

  const realWorkspaces = (workspaceList?.rows || []).filter((w) => w.id !== 'isp-default');
  const designWorkspace = currentWorkspaceId && currentWorkspaceId !== 'isp-default' ? currentWorkspaceId
    : realWorkspaces.find((w) => w.id === lastWorkspace)?.id || realWorkspaces[0]?.id || '';
  const savedDesigns = (designs || []).filter((d) => d.blocks > 0 && (!currentWorkspaceId || d.workspaceId === currentWorkspaceId));
  const openDesignId = pathname.match(/^\/reports\/designed\/(\d+)/)?.[1];
  const hasMoreSessions = (recentSessions?.length ?? 0) < sessionsTotal;

  return (
    <>
      <div className="sticky top-0 z-10 flex h-20 items-center gap-3 border-b border-zinc-200/70 bg-white/90 px-5 backdrop-blur-xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-700 text-white">
          <LayoutDashboard size={19} />
        </div>
        <div>
          <p className="text-sm font-bold text-zinc-800">Business Intelligence</p>
          <p className="text-xs text-zinc-500">Read-only analytics</p>
        </div>
        <NotificationBell />
      </div>

      <div className="space-y-5 px-3.5 py-5">
        <nav className="space-y-1.5">
          {navItems.filter((item) => (!item.permission || can(user, item.permission)) && (item.label !== 'Design report' || !!designWorkspace)).map((item) => {
            const Icon = item.icon;
            const selected = active === item.label && !(item.label === 'Chat' && pathname.startsWith('/data-sources/'));
            return (
              <Link
                key={item.href}
                href={item.label === 'Design report' ? `/data-sources/${encodeURIComponent(designWorkspace)}/design` : item.label === 'Chat' ? !currentWorkspaceId ? '/chat' : currentWorkspaceId === 'isp-default' ? '/chat?original=1' : `/data-sources/${encodeURIComponent(currentWorkspaceId)}/chat${currentSourceId ? `?source=${encodeURIComponent(currentSourceId)}` : ''}` : ['Reports', 'Exports', 'Settings'].includes(item.label) ? `${item.href}${scopeQuery ? `?${scopeQuery}` : ''}` : item.href}
                onClick={onNavigate}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold transition ${
                  selected
                    ? 'border border-rose-100 bg-rose-50 text-rose-800'
                    : 'text-zinc-600 hover:bg-white hover:text-zinc-800 hover:shadow-sm'
                }`}
              >
                <Icon size={17} className={selected ? 'text-rose-700' : 'text-zinc-400'} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>


        {user && (
          <nav aria-label="Workspaces" className="space-y-3 border-t border-zinc-200 pt-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">Workspaces</p>
              {can(user, 'setup.manage') ? <Link href="/data-sources" onClick={onNavigate} title="Create or manage workspaces" aria-label="Create or manage workspaces" className="rounded-md p-1 text-rose-700 hover:bg-rose-50"><Plus size={16} /></Link> : null}
            </div>
            {can(user, 'data.all') ? <Link href="/chat?original=1" onClick={onNavigate} aria-current={currentWorkspaceId === 'isp-default' ? 'page' : undefined} className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${currentWorkspaceId === 'isp-default' ? 'bg-rose-50 font-semibold text-rose-800' : 'text-zinc-600 hover:bg-zinc-50'}`}><MessageSquareText size={16} />Original workspace</Link> : null}
            {workspaceList?.userId !== user.id ? <p className="px-2 text-xs text-zinc-500">Loading...</p> : workspaceList.error ? <p role="alert" className="px-2 text-xs text-red-700">{workspaceList.error}</p> : workspaceList.rows.length === 0 ? (can(user, 'setup.manage') ? <Link href="/data-sources" onClick={onNavigate} className="block px-2 text-sm text-rose-700">Create workspace</Link> : <p className="px-2 text-xs text-zinc-500">No workspaces yet. Ask your admin for access.</p>) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {workspaceList.rows.filter((w) => w.id !== 'isp-default').map((w) => {
                  const selected = currentWorkspaceId === w.id;
                  return <div key={w.id}>
                    {renamingWorkspace===w.id ? <form onSubmit={e=>{e.preventDefault();void saveWorkspaceName(w.id);}} className="space-y-2 p-2">
                      <input autoFocus aria-label="Workspace name" maxLength={200} value={workspaceName} onChange={e=>setWorkspaceName(e.target.value)} className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm" />
                      <div className="flex gap-2"><button disabled={workspaceSaving||!workspaceName.trim()} className="text-sm font-medium text-rose-700">{workspaceSaving?'Saving...':'Save'}</button><button type="button" disabled={workspaceSaving} onClick={()=>setRenamingWorkspace(null)} className="text-sm text-zinc-500">Cancel</button></div>
                      {workspaceRenameError&&<p role="alert" className="text-xs text-red-700">{workspaceRenameError}</p>}
                    </form> : <div className={`flex items-center rounded-md ${selected?'bg-rose-50':''}`}>
                      <Link href={`/data-sources/${encodeURIComponent(w.id)}/chat${selected&&currentSourceId?`?source=${encodeURIComponent(currentSourceId)}`:''}`} onClick={onNavigate} aria-current={selected?'page':undefined} title={w.name} className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-sm ${selected?'font-semibold text-rose-800':'text-zinc-600 hover:bg-zinc-50'}`}><MessageSquareText size={16} className="shrink-0"/><span className="min-w-0 break-words">{w.name}</span></Link>
                      {can(user, 'setup.manage') ? <button type="button" aria-label={`Rename ${w.name}`} title="Rename workspace" onClick={()=>{setRenamingWorkspace(w.id);setWorkspaceName(w.name);setWorkspaceRenameError('');}} className="mr-1 rounded-md p-2 text-zinc-500 hover:bg-white hover:text-rose-700"><Pencil size={14}/></button> : null}
                    </div>}
                  </div>;
                })}
              </div>
            )}
          </nav>
        )}

        {user && savedDesigns.length > 0 && (
          <nav aria-label="Designed reports" className="space-y-3 border-t border-zinc-200 pt-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">Designed reports</p>
              <Link href="/reports/designed" onClick={onNavigate} className="text-[11px] font-semibold text-rose-700 hover:text-rose-800">View all</Link>
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {savedDesigns.slice(0, 8).map((d) => {
                const selected = openDesignId === String(d.id);
                return (
                  <Link key={d.id} href={`/reports/designed/${d.id}?workspace=${encodeURIComponent(d.workspaceId)}`} onClick={onNavigate} title={d.title}
                    className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${selected ? 'bg-rose-50 font-semibold text-rose-800' : 'text-zinc-600 hover:bg-zinc-50'}`}>
                    <Sparkles size={15} className="shrink-0" /><span className="truncate">{d.title}</span>
                  </Link>
                );
              })}
            </div>
          </nav>
        )}

        {user && sessionsScope === scopeQuery && recentSessions ? (
          <nav className="space-y-4 border-t border-zinc-200 pt-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">Recent Chats</p>
              <Link href={`/sessions?${scopeQuery}`} onClick={onNavigate} className="text-[11px] font-semibold text-rose-700 hover:text-rose-800">
                View all
              </Link>
            </div>
            <div className="space-y-1">
              {recentSessions.length === 0 && <p className="px-2 text-xs text-zinc-500">No chats in this workspace yet.</p>}
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
                      className="block w-full truncate rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm outline-none ring-2 ring-rose-100"
                    />
                  ) : (
                    <div
                      key={session.id}
                      className={`group flex items-center gap-1 rounded-lg pr-1 transition ${
                        isActiveSession
                          ? 'bg-white shadow-sm ring-1 ring-zinc-200'
                          : 'hover:bg-white hover:shadow-sm'
                      }`}
                    >
                      <Link
                        href={session.tool_chat && session.warehouse_id ? `/data-sources/${encodeURIComponent(session.warehouse_id)}/chat?session=${session.id}` : `/chat?session=${session.id}`}
                        onClick={onNavigate}
                        className="block min-w-0 flex-1 px-3 py-2"
                        title={session.title}
                      >
                        <span
                          className={`block truncate text-sm font-medium leading-tight ${
                            isActiveSession ? 'text-zinc-800' : 'text-zinc-700 group-hover:text-zinc-800'
                          }`}
                        >
                          {session.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-medium leading-tight text-zinc-400">
                          {formatSessionTimestamp(session.updated_at)}
                        </span>
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`Options for ${session.title}`}
                              className="shrink-0 rounded-md p-1.5 text-zinc-400 opacity-0 transition hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
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
                className="w-full rounded-lg px-3 py-2 text-center text-xs font-semibold text-rose-700 transition hover:bg-white hover:text-rose-800 disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            ) : null}
          </nav>
        ) : null}

        <nav className="space-y-2 border-t border-zinc-200 pt-5">
          <div className="flex items-center justify-between px-2">
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">Account</p>
          </div>
          {loading ? null : user ? (
            <div className="space-y-2 px-1">
              <div className="rounded-lg bg-white px-3 py-2.5 text-sm shadow-sm">
                <p className="truncate font-semibold text-zinc-800">{user.displayName || user.email}</p>
                <p className="truncate text-xs text-zinc-400">{user.email}</p>
              </div>
              <Link href="/security" onClick={onNavigate} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-zinc-600 transition hover:bg-white hover:text-zinc-800 hover:shadow-sm">
                <ShieldCheck size={15} className="text-zinc-400" />
                Account security
              </Link>
              <button
                type="button"
                onClick={() => logout()}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-zinc-600 transition hover:bg-white hover:text-zinc-800 hover:shadow-sm"
              >
                <LogOut size={15} className="text-zinc-400" />
                Sign out
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              onClick={onNavigate}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-600 transition hover:bg-white hover:text-zinc-800 hover:shadow-sm"
            >
              <LogIn size={15} className="text-zinc-400" />
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
const COLLAPSE_KEY = 'bi:sidebarCollapsed';
/** Full or icons-only sidebar, remembered per browser. */
export function useSidebarCollapsed(defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  useEffect(() => {
    const read = () => { try { const v = localStorage.getItem(COLLAPSE_KEY); if (v != null) setCollapsed(v === '1'); } catch {} };
    read();
    window.addEventListener('bi:sidebar', read);
    return () => window.removeEventListener('bi:sidebar', read);
  }, []);
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch {}
    setTimeout(() => window.dispatchEvent(new Event('bi:sidebar')), 0);
    return !c;
  });
  return { collapsed, toggle };
}

function IconRail({ active, onExpand }: { active: string; onExpand: () => void }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams();
  const ws = pathname.match(/^\/data-sources\/([^/]+)/)?.[1] || search.get('workspace') || '';
  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-4">
      <Link href="/chat" title="Business Intelligence" className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-rose-700 text-white"><LayoutDashboard size={19} /></Link>
      {navItems.filter((item) => (!item.permission || can(user, item.permission)) && (item.label !== 'Design report' || (ws && ws !== 'isp-default'))).map((item) => {
        const Icon = item.icon; const selected = active === item.label;
        return (
          <Link key={item.href} href={item.label === 'Design report' ? `/data-sources/${ws}/design` : item.href} title={item.label} aria-label={item.label}
            className={`group relative flex h-10 w-10 items-center justify-center rounded-lg transition ${selected ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-100' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'}`}>
            <Icon size={18} />
            <span className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow transition group-hover:opacity-100">{item.label}</span>
          </Link>
        );
      })}
      <div className="flex-1" />
      <button type="button" onClick={onExpand} title="Expand sidebar" aria-label="Expand sidebar" className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><PanelLeftOpen size={18} /></button>
    </div>
  );
}

// Desktop: full column or an icons-only rail (toggle remembered). Hidden
// below lg, where MobileSidebarTrigger takes over.
export function WorkspaceSidebar({ active, defaultCollapsed = false }: { active: string; defaultCollapsed?: boolean }) {
  const { collapsed, toggle } = useSidebarCollapsed(defaultCollapsed);
  if (collapsed) return (
    <aside className="hidden h-screen w-[68px] shrink-0 border-r border-zinc-200 bg-white lg:block">
      <IconRail active={active} onExpand={toggle} />
    </aside>
  );
  return (
    <aside className="relative hidden h-screen w-[260px] shrink-0 border-r border-zinc-200 bg-white lg:block">
      <div className="h-full overflow-y-auto"><SidebarContent active={active} /></div>
    </aside>
  );
}

/** Always-visible on/off switch for the left panel, placed next to the page title. */
export function SidebarToggle() {
  const { collapsed, toggle } = useSidebarCollapsed();
  return (
    <button type="button" onClick={toggle} title={collapsed ? 'Show menu names' : 'Icons only'} aria-label={collapsed ? 'Show full left menu' : 'Show icons only'}
      className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition hover:border-rose-200 hover:text-rose-700 lg:flex print:hidden">
      {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
    </button>
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
