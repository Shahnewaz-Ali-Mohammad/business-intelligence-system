'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, MessageSquare, PanelLeftClose, Columns2, Download, History, LineChart as LineIcon, Loader2, PieChart as PieIcon, Printer, Redo2, RefreshCw, Send, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { SidebarToggle, WorkspaceSidebar } from '@/components/workspace/workspace-sidebar';
import { BlockBody, label, type BlockData } from './block-view';
import { isDataBlock, type Block, type Message, type Spec } from '@/lib/designer/spec';
import { base64ToBlob, buildWorkbookBase64, triggerDownload, XLSX_MIME_TYPE } from '@/lib/download';

const STARTERS = [
  'Build a monthly performance overview with KPIs, trends and a detail table',
  'Show the top 10 by volume as a bar chart with an analysis',
  'Create a status breakdown with a donut chart and counts',
  'Trend of records per month for this year',
];
const STAGES = ['Reading the approved data', 'Planning the layout', 'Checking every query', 'Running on live data', 'Writing the analysis'];
const span: Record<Block['width'], string> = { full: 'col-span-6', half: 'col-span-6 md:col-span-3', third: 'col-span-6 md:col-span-3 xl:col-span-2' };
const nextWidth: Record<Block['width'], Block['width']> = { full: 'half', half: 'third', third: 'full' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d as T;
}

export function ReportDesigner({ designId }: { designId: string }) {
  return (
    <main className="flex h-screen overflow-hidden bg-[#f5f6f8] text-zinc-800 print:block print:h-auto print:overflow-visible print:bg-white">
      <div className="print:hidden"><Suspense fallback={null}><WorkspaceSidebar active="Design report" defaultCollapsed /></Suspense></div>
      <Designer designId={designId} />
    </main>
  );
}

function Designer({ designId }: { designId: string }) {
  const base = `/api/designs/${encodeURIComponent(designId)}`;
  const [spec, setSpec] = useState<Spec | null>(null);
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [data, setData] = useState<Record<string, BlockData>>({});
  const [loadingData, setLoadingData] = useState(false);
  const [loadingBlocks, setLoadingBlocks] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [past, setPast] = useState<Spec[]>([]);
  const [future, setFuture] = useState<Spec[]>([]);
  const [versions, setVersions] = useState<{ id: number; note: string; created_at: string }[] | null>(null);
  const [notice, setNotice] = useState('');
  const [chatOpen, setChatOpen] = useState(true);
  const chatEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async (target?: Spec) => {
    const blocks = target?.blocks.filter(isDataBlock) || [];
    if (!blocks.length) return;
    setLoadingData(true);
    setLoadingBlocks(new Set(blocks.map((b) => b.id)));
    await Promise.all(blocks.map(async (block) => {
      try {
        const d = await api<{ blockId: string; data: BlockData }>(`${base}/run`, { method: 'POST', body: JSON.stringify({ blockId: block.id }) });
        setData((current) => ({ ...current, [d.blockId]: d.data }));
      } catch (e) { setData((current) => ({ ...current, [block.id]: { rows: [], hasMore: false, error: (e as Error).message } })); }
      finally { setLoadingBlocks((current) => { const next = new Set(current); next.delete(block.id); return next; }); }
    }));
    setLoadingData(false);
  }, [base]);

  useEffect(() => {
    api<{ design: { spec: Spec; messages: Message[] }; workspace: { id: string; name: string } | null }>(base)
      .then((d) => { setSpec(d.design.spec); setMessages(d.design.messages); setWorkspace(d.workspace); if (d.design.spec.blocks.length) refresh(d.design.spec); })
      .catch((e) => setError(e.message));
  }, [base, refresh]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => { if (!busy) return; setStage(0); const t = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 2600); return () => clearInterval(t); }, [busy]);
  useEffect(() => { if (!changed.size) return; const t = setTimeout(() => setChanged(new Set()), 2400); return () => clearTimeout(t); }, [changed]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(t); }, [notice]);

  async function send(value = text) {
    const prompt = value.trim(); if (!prompt || busy || !spec) return;
    setText(''); setBusy(true);
    setMessages((m) => [...m, { role: 'user', text: prompt, at: new Date().toISOString(), blockId: selected }]);
    try {
      const d = await api<{ spec: Spec; data: Record<string, BlockData>; messages: Message[]; suggestions: string[]; changed: string[] }>(`${base}/prompt`, { method: 'POST', body: JSON.stringify({ text: prompt, selectedBlockId: selected, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      setPast((p) => [...p.slice(-30), spec]); setFuture([]);
      setSpec(d.spec); setData(d.data); setMessages(d.messages); setSuggestions(d.suggestions || []); setChanged(new Set(d.changed));
      // Refresh each changed block independently so the canvas can render while slower queries finish.
      refresh(d.spec);
      if (selected && !d.spec.blocks.some((b) => b.id === selected)) setSelected(null);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: (e as Error).message, at: new Date().toISOString() }]);
    } finally { setBusy(false); input.current?.focus(); }
  }

  /** Hand edits: applied at once, saved in the background, undoable. */
  async function edit(next: Spec, note: string, rerun = false) {
    if (!spec) return;
    setPast((p) => [...p.slice(-30), spec]); setFuture([]); setSpec(next);
    try { await api(base, { method: 'PUT', body: JSON.stringify({ spec: next, note }) }); if (rerun) refresh(); }
    catch (e) { setNotice((e as Error).message); setSpec(spec); }
  }
  async function jump(target: Spec, from: 'undo' | 'redo') {
    if (!spec) return;
    if (from === 'undo') { setPast((p) => p.slice(0, -1)); setFuture((f) => [spec, ...f]); } else { setFuture((f) => f.slice(1)); setPast((p) => [...p, spec]); }
    setSpec(target);
    try { await api(base, { method: 'PUT', body: JSON.stringify({ spec: target, note: from === 'undo' ? 'Undo' : 'Redo' }) }); refresh(); } catch (e) { setNotice((e as Error).message); }
  }
  const updateBlock = (id: string, patch: Partial<Block>, note: string) => spec && edit({ ...spec, blocks: spec.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }, note);
  const moveBlock = (id: string, dir: -1 | 1) => {
    if (!spec) return; const i = spec.blocks.findIndex((b) => b.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= spec.blocks.length) return;
    const blocks = [...spec.blocks]; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; edit({ ...spec, blocks }, 'Moved a block');
  };
  const removeBlock = (id: string) => { if (!spec) return; if (selected === id) setSelected(null); edit({ ...spec, blocks: spec.blocks.filter((b) => b.id !== id && b.sourceBlockId !== id) }, 'Removed a block'); };

  async function openVersions() { try { setVersions((await api<{ versions: typeof versions }>(`${base}/versions`)).versions || []); } catch (e) { setNotice((e as Error).message); } }
  async function restore(versionId: number) {
    try { const d = await api<{ spec: Spec; data: Record<string, BlockData> }>(`${base}/versions`, { method: 'POST', body: JSON.stringify({ versionId }) }); if (spec) setPast((p) => [...p, spec]); setSpec(d.spec); setData(d.data); setVersions(null); setNotice('Earlier version restored.'); }
    catch (e) { setNotice((e as Error).message); }
  }

  function exportExcel() {
    if (!spec) return;
    const sheets = spec.blocks.filter((b) => (b.type === 'table' || b.type === 'chart' || b.type === 'kpi') && data[b.id]?.rows?.length).map((b, i) => {
      const rows = data[b.id].rows; const headers = Object.keys(rows[0]);
      return { name: `${i + 1} ${b.title}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), headers: headers.map(label), rows: rows.map((r) => headers.map((h) => (typeof r[h] === 'number' ? (r[h] as number) : r[h] == null ? '' : String(r[h])))) };
    });
    if (!sheets.length) { setNotice('Nothing to export yet.'); return; }
    triggerDownload(`${spec.title.replace(/[^\w -]+/g, '').trim() || 'report'}.xlsx`, base64ToBlob(buildWorkbookBase64(sheets), XLSX_MIME_TYPE));
  }

  const selectedBlock = useMemo(() => spec?.blocks.find((b) => b.id === selected) || null, [spec, selected]);

  if (error) return <div className="flex flex-1 items-center justify-center p-8"><div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm"><p className="font-semibold">This report could not be opened</p><p className="mt-2 text-sm text-zinc-500">{error}</p><Link href="/chat" className="mt-5 inline-block text-sm font-semibold text-rose-700 hover:underline">Back to chat</Link></div></div>;
  if (!spec) return <div className="flex flex-1 items-center justify-center text-sm text-zinc-400"><Loader2 className="mr-2 animate-spin" size={16} />Opening the designer…</div>;

  return (
    <>
      {/* Conversation */}
      <section className={`${chatOpen ? 'flex' : 'hidden'} w-[360px] shrink-0 flex-col border-r border-zinc-200 bg-white print:hidden`}>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
          <SidebarToggle />
          <Link href={workspace ? `/data-sources/${encodeURIComponent(workspace.id)}/chat` : '/chat'} title="Back" className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><ArrowLeft size={16} /></Link>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles size={14} className="text-rose-700" />Report designer</p>
            <p className="truncate text-xs text-zinc-400">{workspace?.name || 'Workspace'}</p>
          </div>
          <button type="button" onClick={() => setChatOpen(false)} title="Hide chat" aria-label="Hide chat" className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><PanelLeftClose size={16} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!messages.length && (
            <div className="rounded-xl bg-gradient-to-br from-rose-50 to-white p-4 ring-1 ring-rose-100">
              <p className="text-sm font-semibold text-zinc-800">Describe the report you need</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">It is built on the canvas from this workspace&apos;s approved data. Keep talking to change it, or click a block and ask about that one.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${m.role === 'user' ? 'rounded-br-md bg-zinc-900 text-white' : 'rounded-bl-md bg-zinc-100 text-zinc-800'}`}>
                {m.blockId && m.role === 'user' && <span className="mb-1 block text-[11px] text-zinc-400">On: {spec.blocks.find((b) => b.id === m.blockId)?.title || 'a block'}</span>}
                {m.text}
              </div>
            </div>
          ))}
          {busy && (
            <div className="rounded-2xl rounded-bl-md bg-zinc-100 px-3.5 py-3 text-sm">
              {STAGES.map((s, i) => (
                <p key={s} className={`flex items-center gap-2 py-0.5 transition ${i < stage ? 'text-zinc-400' : i === stage ? 'font-medium text-zinc-800' : 'hidden'}`}>
                  {i < stage ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : <Loader2 size={12} className="animate-spin text-rose-700" />}{s}
                </p>
              ))}
            </div>
          )}
          <div ref={chatEnd} />
        </div>
        <div className="shrink-0 border-t border-zinc-100 p-3">
          {!busy && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(messages.length ? suggestions : STARTERS).slice(0, 4).map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-left text-xs text-zinc-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-800">{s}</button>
              ))}
            </div>
          )}
          {selectedBlock && (
            <div className="mb-2 flex items-center justify-between rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
              <span className="truncate">Changing: <b>{selectedBlock.title || selectedBlock.type}</b></span>
              <button type="button" onClick={() => setSelected(null)} aria-label="Clear selection"><X size={13} /></button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white p-2 shadow-sm focus-within:border-rose-300 focus-within:ring-2 focus-within:ring-rose-100">
            <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={selectedBlock ? 'e.g. make this a line chart by month' : 'e.g. add a chart of revenue by zone'}
              className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-zinc-400" />
            <button type="button" onClick={() => send()} disabled={busy || !text.trim()} aria-label="Send" className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-700 text-white transition hover:bg-rose-800 disabled:bg-zinc-200">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </section>

      {/* Canvas */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden print:overflow-visible">
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-white/80 px-5 backdrop-blur print:hidden">
          <div className="flex items-center gap-1">
            {!chatOpen && <button type="button" onClick={() => setChatOpen(true)} className="mr-2 inline-flex h-9 items-center gap-2 rounded-lg bg-rose-700 px-3 text-sm font-semibold text-white hover:bg-rose-800"><MessageSquare size={15} />Show chat</button>}
            <Tool title="Undo" onClick={() => past.length && jump(past[past.length - 1], 'undo')} disabled={!past.length || busy}><Undo2 size={16} /></Tool>
            <Tool title="Redo" onClick={() => future.length && jump(future[0], 'redo')} disabled={!future.length || busy}><Redo2 size={16} /></Tool>
            <Tool title="Version history" onClick={openVersions} disabled={busy}><History size={16} /></Tool>
            <Tool title="Refresh data" onClick={() => refresh(spec || undefined)} disabled={busy || loadingData}><RefreshCw size={16} className={loadingData ? 'animate-spin' : ''} /></Tool>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => window.print()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"><Printer size={15} />PDF</button>
            <button type="button" onClick={exportExcel} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-700"><Download size={15} />Excel</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto print:overflow-visible" onClick={() => setSelected(null)}>
          <div className="mx-auto max-w-6xl px-6 py-8 print:max-w-none print:p-0">
            <div className="mb-6">
              <input value={spec.title} onChange={(e) => setSpec({ ...spec, title: e.target.value })} onBlur={() => edit(spec, 'Renamed the report')} onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-3xl font-bold tracking-tight text-zinc-900 outline-none placeholder:text-zinc-300 focus:rounded-md focus:ring-2 focus:ring-rose-100" placeholder="Untitled report" maxLength={200} />
              <input value={spec.subtitle} onChange={(e) => setSpec({ ...spec, subtitle: e.target.value })} onBlur={() => edit(spec, 'Edited the subtitle')} onClick={(e) => e.stopPropagation()}
                className="mt-1 w-full bg-transparent text-sm text-zinc-500 outline-none placeholder:text-zinc-300" placeholder="Add a subtitle" maxLength={400} />
            </div>
            {!spec.blocks.length ? (
              <div className="grid grid-cols-6 gap-4">
                {busy ? ['col-span-2 h-28', 'col-span-2 h-28', 'col-span-2 h-28', 'col-span-3 h-64', 'col-span-3 h-64', 'col-span-6 h-64'].map((c, i) => <div key={i} className={`${c} animate-pulse rounded-2xl bg-white ring-1 ring-zinc-200`} />) : (
                  <div className="col-span-6 flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-zinc-200 bg-white/60 px-6 py-24 text-center">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-700"><Sparkles size={24} /></div>
                    <p className="text-lg font-semibold">Your canvas is empty</p>
                    <p className="mt-1 max-w-md text-sm text-zinc-500">Tell the designer on the left what this report is for. It picks the KPIs, charts and tables from approved data and lays them out here.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-6 gap-4 print:gap-3">
                {spec.blocks.map((b, i) => (
                  <BlockCard key={b.id} block={b} data={data[b.id]} loading={loadingBlocks.has(b.id) || (busy && changed.has(b.id))} selected={selected === b.id} fresh={changed.has(b.id)}
                    first={i === 0} last={i === spec.blocks.length - 1}
                    onSelect={() => { setSelected(b.id); input.current?.focus(); }}
                    onMove={(d) => moveBlock(b.id, d)} onRemove={() => removeBlock(b.id)}
                    onWidth={() => updateBlock(b.id, { width: nextWidth[b.width] }, 'Resized a block')}
                    onKind={(chartKind) => updateBlock(b.id, { chartKind }, 'Changed the chart type')} />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {versions && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20 print:hidden" onClick={() => setVersions(null)}>
          <div className="h-full w-80 overflow-y-auto bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between"><p className="font-semibold">Version history</p><button type="button" onClick={() => setVersions(null)} aria-label="Close"><X size={16} /></button></div>
            {!versions.length ? <p className="text-sm text-zinc-500">No earlier versions yet.</p> : versions.map((v) => (
              <button key={v.id} type="button" onClick={() => restore(v.id)} className="mb-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-left hover:border-rose-200 hover:bg-rose-50">
                <p className="truncate text-sm font-medium">Before: {v.note || 'a change'}</p>
                <p className="text-xs text-zinc-400">{new Date(v.created_at).toLocaleString()}</p>
              </button>
            ))}
          </div>
        </div>
      )}
      {notice && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg print:hidden">{notice}</div>}
    </>
  );
}

function Tool({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30">{children}</button>;
}

function BlockCard({ block, data, loading, selected, fresh, first, last, onSelect, onMove, onRemove, onWidth, onKind }: {
  block: Block; data?: BlockData; loading: boolean; selected: boolean; fresh: boolean; first: boolean; last: boolean;
  onSelect: () => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onWidth: () => void; onKind: (k: NonNullable<Block['chartKind']>) => void;
}) {
  const plain = block.type === 'heading';
  return (
    <div onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className={`group relative ${span[block.width]} cursor-pointer break-inside-avoid rounded-2xl transition-all duration-300 print:cursor-auto ${plain ? 'px-1' : 'bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.04)] ring-1'} ${selected ? 'ring-2 ring-rose-400' : plain ? '' : 'ring-zinc-200 hover:ring-zinc-300'} ${fresh ? 'animate-[pulse_1.2s_ease-in-out_1] ring-2 ring-emerald-300' : ''} ${block.type === 'insight' ? 'bg-gradient-to-br from-amber-50/60 to-white' : ''}`}>
      {!plain && block.type !== 'insight' && (
        <p className={`mb-3 pr-24 font-semibold text-zinc-800 ${block.type === 'kpi' ? 'text-xs uppercase tracking-wide text-zinc-500' : 'text-sm'}`}>{block.title}</p>
      )}
      <BlockBody block={block} data={data} loading={loading} />
      <div className={`absolute right-3 top-3 flex items-center gap-0.5 rounded-lg bg-white/95 p-0.5 shadow-sm ring-1 ring-zinc-200 transition print:hidden ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => e.stopPropagation()}>
        {block.type === 'chart' && (['bar', 'line', 'pie'] as const).map((k) => {
          const Icon = k === 'bar' ? BarChart3 : k === 'line' ? LineIcon : PieIcon;
          return <Mini key={k} title={`${k[0].toUpperCase()}${k.slice(1)} chart`} onClick={() => onKind(k)} active={block.chartKind === k}><Icon size={13} /></Mini>;
        })}
        <Mini title="Change width" onClick={onWidth}><Columns2 size={13} /></Mini>
        <Mini title="Move up" onClick={() => onMove(-1)} disabled={first}><ArrowUp size={13} /></Mini>
        <Mini title="Move down" onClick={() => onMove(1)} disabled={last}><ArrowDown size={13} /></Mini>
        <Mini title="Remove" onClick={onRemove}><Trash2 size={13} /></Mini>
      </div>
    </div>
  );
}

function Mini({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`flex h-7 w-7 items-center justify-center rounded-md transition disabled:opacity-30 ${active ? 'bg-rose-50 text-rose-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'}`}>{children}</button>;
}
