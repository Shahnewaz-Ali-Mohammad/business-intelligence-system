"use client";
import { Suspense, use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WorkspacePage } from "@/components/workspace/workspace-page";
import { ChatWorkspace } from "@/components/chat/chat-workspace";
type Source = { id: string; database: string };
function DatabaseChat({ id }: { id: string }) {
  const search = useSearchParams();
  const router = useRouter();
  const [sources, setSources] = useState<Source[]>([]);
  const [resolvedSource, setResolvedSource] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("Chat Workspace");
  const session = search.get("session");
  const requestedSource = search.get("source");
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/workspaces/${id}/tool-setup`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Workspace unavailable.");
        let sourceId = requestedSource || "";
        if (session) {
          const r = await fetch(`/api/chat-sessions/${session}`);
          const conversation = await r.json();
          if (!r.ok || conversation.session?.warehouse_id !== id) throw new Error("Conversation belongs to another workspace.");
          const saved = [...conversation.messages].reverse().find((m: { report_data?: { workspaceToolAnswer?: { sourceId?: string } } }) => m.report_data?.workspaceToolAnswer?.sourceId)?.report_data.workspaceToolAnswer.sourceId;
          if (sourceId && saved && sourceId !== saved) throw new Error("Conversation belongs to another database.");
          sourceId = saved || sourceId;
        }
        if (!sourceId && data.sources.length) sourceId = data.sources[0].id;
        if (sourceId && !data.sources.some((s: Source) => s.id === sourceId)) throw new Error("This saved database is no longer available.");
        if (!cancelled) {
          setSources(data.sources); setResolvedSource(sourceId); setError(""); setLoaded(true);
          if (sourceId && !requestedSource) router.replace(`/data-sources/${id}/chat?source=${encodeURIComponent(sourceId)}${session ? `&session=${encodeURIComponent(session)}` : ''}`, { scroll: false });
        }
        const workspaces = await fetch('/api/workspaces').then((r) => r.json());
        if (!cancelled) setName(workspaces.workspaces?.find((w: { id: string }) => w.id === id)?.name || "Chat Workspace");
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : "Could not load workspace."); setLoaded(true); } }
    }
    load();
    return () => { cancelled = true; };
  }, [id, session, requestedSource, router]);
  useEffect(()=>{
    const update=()=>{void fetch('/api/workspaces').then(r=>r.json()).then(body=>setName(body.workspaces?.find((w:{id:string})=>w.id===id)?.name||'Chat Workspace')).catch(()=>{});};
    window.addEventListener('bi:workspaces-changed',update);return()=>window.removeEventListener('bi:workspaces-changed',update);
  },[id]);
  const source = sources.find((s) => s.id === resolvedSource);
  return <WorkspacePage active="Chat" title="Chat Workspace" subtitle={source ? `${name} · Ask questions, explore your data, and save reports.` : "Choose your connected database"}>
    <div className="flex h-full min-h-0 flex-col gap-3">
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : source ? <div className="min-h-0 flex-1"><ChatWorkspace key={`${id}:${source.id}`} databaseWorkspace={{ id, sourceId: source.id, database: source.database, name }} /></div> : <p className="text-sm text-zinc-500">{!loaded ? 'Loading workspace...' : sources.length ? 'Choose a connected database.' : 'Connect a database in Tool setup.'}</p>}
    </div>
  </WorkspacePage>;
}
export default function ToolChat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={null}><DatabaseChat key={id} id={id} /></Suspense>;
}
