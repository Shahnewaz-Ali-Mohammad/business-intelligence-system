"use client";

import { use, useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  Database,
  Plug,
  RefreshCw,
  Sparkles,
  Play,
  Check,
  Trash2,
  Plus,
  Pencil,
  X,
} from "lucide-react";
import { WorkspacePage } from "@/components/workspace/workspace-page";
import { ToolPlanEditor } from "@/components/data-sources/tool-plan-editor";
import { ToolTestControls } from "@/components/data-sources/tool-test-controls";
import type {
  Catalog,
  SourceConfig,
  ToolDefinition,
} from "@/lib/tool-setup/store";

// One line describing what a generation run did to the saved tools.
function generationSummary(data: { added?: number; updated?: number; unchanged?: number; removed?: number; aiCount?: number; genericCount?: number; coverage?: {totalFields:number;verifiedRelationships:number;inferredRelationships:number} }) {
  if (typeof data.added !== "number") return `${data.aiCount ?? 0} business tools saved for review.`;
  const coverage=data.coverage?` Coverage: ${data.coverage.totalFields} selected fields, ${data.coverage.verifiedRelationships} available relationship paths (${data.coverage.inferredRelationships} inferred from named primary keys).`:'';
  return `Generation finished: ${data.added} new, ${data.updated ?? 0} updated, ${data.unchanged ?? 0} already existed, ${data.removed ?? 0} old drafts removed. Approved tools were not changed.${coverage} Review and approve the tools you want in chat.`;
}


type Server = {
  id: string;
  name: string;
  dialect: SourceConfig["dialect"];
  host: string;
  port: number;
};
type Source = {
  id: string;
  serverId: string;
  database: string;
  catalog: Catalog;
};
type Tool = {
  id: string;
  sourceId: string;
  definition: ToolDefinition;
  status: string;
  version: number;
};
type Setup = {
  servers: Server[];
  reusableServers?: { id: string; name: string; workspace: string; dialect: string; host: string; port: number }[];
  sources: Source[];
  tools: Tool[];
  generationModel: string | null;
};
type Preview = {
  rows: Record<string, unknown>[];
  hasMore: boolean;
  limit: number;
  elapsedMs: number;
  scope: string;
};
const inputClass =
  "h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100 disabled:opacity-50";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-40";
const primaryClass =
  "inline-flex items-center justify-center gap-2 rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-800 disabled:opacity-40";

export default function ToolSetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [setup, setSetup] = useState<Setup>({
    servers: [],
    sources: [],
    tools: [],
    generationModel: null,
  });
  const [config, setConfig] = useState<SourceConfig>({
    dialect: "sqlserver",
    host: "",
    port: 1433,
    username: "",
    password: "",
    database: "",
    tls: true,
    trustServerCertificate: false,
  });
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const operationAbort = useRef<AbortController | null>(null);
  const generationJobRef = useRef<string | null>(null);
  const generationStartedAt=useRef(0);
  const [resumableJob,setResumableJob]=useState<string|null>(null);
  const [generationProgress, setGenerationProgress] = useState('');
  const [generationElapsed, setGenerationElapsed] = useState(0);
  useEffect(() => () => operationAbort.current?.abort(), []);
  useEffect(() => {
    if (busy !== 'generate') return;
    const timer = setInterval(() => setGenerationElapsed(Math.floor((Date.now() - generationStartedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ name: string; json: string } | null>(
    null,
  );
  const [testing, setTesting] = useState<Tool | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const source = setup.sources.find((s) => s.id === sourceId);
  const tools = setup.tools.filter((t) => t.sourceId === sourceId);
  const endpoint = `/api/workspaces/${id}/tool-setup`;
  const reload = useCallback(async () => {
    const response = await fetch(`/api/workspaces/${id}/tool-setup`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load setup.");
    setSetup(body);
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${id}/tool-setup`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not load setup.");
        if (!cancelled) {
          setSetup(body);
          setAvailable(true);
          if(body.sources?.length===1)setSourceId(body.sources[0].id);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  async function followGeneration(jobId:string,signal:AbortSignal):Promise<Record<string,unknown>> {
    while(!signal.aborted) {
      const response=await fetch(`${endpoint}?generationJob=${encodeURIComponent(jobId)}`,{signal});
      const body=await response.json();
      if(!response.ok||!body.job)throw new Error(body.error||'Generation job unavailable.');
      const job=body.job;
      generationStartedAt.current=Number(job.startedAt)||generationStartedAt.current;
      setGenerationProgress(job.progress||'Generating');
      if(job.status==='completed') {generationJobRef.current=null;setResumableJob(null);return job.result;}
      if(job.status==='failed'||job.status==='cancelled'){setResumableJob(jobId);throw new Error(job.error||'Generation cancelled. Completed work is kept for retry.');}
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(new Error('Stopped watching generation'));};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},2000);
        signal.addEventListener('abort',abort,{once:true});
      });
    }
    throw new Error('Stopped watching generation');
  }
  async function cancelJob() {
    if(!generationJobRef.current)return;
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancelGeneration',jobId:generationJobRef.current})});
      if(!response.ok)throw new Error('Could not cancel generation.');
      setGenerationProgress('Cancelling; completed work is kept for retry');
    } catch(error){setError(error instanceof Error?error.message:'Could not cancel generation.');}
  }
  useEffect(()=>{
    if(!sourceId)return;
    let disposed=false;
    const controller=new AbortController();
    fetch(`/api/workspaces/${id}/tool-setup?generationSource=${encodeURIComponent(sourceId)}`,{signal:controller.signal}).then(r=>r.json()).then(async(body)=>{
      if(disposed||operationAbort.current||!body.job)return;
      if(['failed','cancelled'].includes(body.job.status)){setResumableJob(body.job.jobId);setGenerationProgress(body.job.progress||'Generation stopped');return;}
      if(!['queued','running'].includes(body.job.status))return;
      generationJobRef.current=body.job.jobId;generationStartedAt.current=Number(body.job.startedAt)||Date.now();operationAbort.current=controller;setBusy('generate');
      try{const result=await followGeneration(body.job.jobId,controller.signal);if(!disposed){await reload();setNotice(generationSummary(result));}}
      catch(error){if(!disposed)setError(error instanceof Error?error.message:'Could not follow generation.');}
      finally{if(!disposed){operationAbort.current=null;setBusy('');}}
    }).catch(()=>{});
    return()=>{disposed=true;controller.abort();};
    // Resume the selected database's saved job after navigation or refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[id,sourceId]);
  const [reuseId, setReuseId] = useState("");
  async function action(
    body: Record<string, unknown>,
    work: (data: Record<string, unknown>) => void = () => {},
  ) {
    if (busy) return;
    const isGeneration=body.action==='generate'||body.action==='resumeGeneration';
    setBusy(isGeneration?'generate':String(body.action));
    setError("");
    setNotice("");
    let completed = false;
    const controller = new AbortController();
    operationAbort.current = controller;
    const signal = controller.signal;
    if (isGeneration) { generationJobRef.current=null; generationStartedAt.current=Date.now(); setGenerationProgress('Preparing selected schema'); setGenerationElapsed(0); }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(body),
      });
      let data = await response.json();
      if(!response.ok)throw new Error(String(data.error||'Operation failed.'));
      if(isGeneration) {
        generationJobRef.current=String(data.jobId);
        data=await followGeneration(String(data.jobId),signal);
      }
      completed = true;
      await reload();
      work(data);
    } catch (e) {
      const reason = signal.aborted ? 'Stopped watching generation. The saved job remains available.' : e instanceof Error ? e.message : 'Operation failed.';
      if(isGeneration&&generationJobRef.current)setResumableJob(generationJobRef.current);
      setError(
        isGeneration
          ? completed
            ? `Tools were generated and saved, but refreshing the registry failed. ${reason} Reload the page to see the saved tools.`
            : `Generation status: ${reason} Completed schema groups are kept; use Resume generation to continue or reconnect.`
          : reason,
      );
    } finally {
      operationAbort.current = null;
      setBusy("");
    }
  }
  function chooseSource(next: string) {
    setSourceId(next);
    setResumableJob(null);
    setSelected({});
    setExpanded(null);
    setTesting(null);
    setPreview(null);
    setConsent(false);
    setEditor(null);
  }
  function newTool() {
    const base = source?.catalog.objects.find((o) => o.kind !== "procedure");
    if (!base) return;
    const definition: ToolDefinition = {
      name: "new_read_only_tool",
      description: "Read selected records from this database.",
      base: base.id,
      joins: [],
      mode: "rows",
      columns: base.columns
        .filter((c) => !c.restricted)
        .slice(0, 5)
        .map((c) => `${base.id}:${c.name}`),
      groupBy: [],
      metrics: [],
      filters: [],
    };
    setEditor({ name: "Add tool", json: JSON.stringify(definition, null, 2) });
  }
  return (
    <WorkspacePage
      active="Settings"
      title="Database & Tool Setup"
      subtitle="Connections, objects, and approved tools"
      scroll
    >
      <div className="mx-auto max-w-6xl space-y-8 pb-10">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}
        {!available && (
          <div className="flex items-center gap-4 text-sm">
            <Link href="/login" className="text-rose-800 hover:underline">
              Sign in
            </Link>
            <button
              className={buttonClass}
              onClick={() =>
                reload()
                  .then(() => {
                    setAvailable(true);
                    setError("");
                  })
                  .catch((e) => setError(e.message))
              }
            >
              <RefreshCw size={15} />
              Retry setup
            </button>
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
          >
            {notice}
          </div>
        )}
        <section className="border-b border-zinc-200 pb-7">
          <Link
            href={`/data-sources/${id}/chat${sourceId ? `?source=${encodeURIComponent(sourceId)}` : ''}`}
            className="mb-4 inline-flex text-sm font-medium text-rose-700 hover:underline"
          >
            Open workspace chat
          </Link>
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Plug size={18} />
            Server Connection
          </h2>
          {!!setup.reusableServers?.length && (
            <div className="mb-5 flex flex-wrap items-end gap-3">
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
                <span>Use a saved connection from another workspace</span>
                <select className={inputClass} value={reuseId} onChange={(e) => setReuseId(e.target.value)}>
                  <option value="">Select saved connection</option>
                  {setup.reusableServers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} · {s.dialect} · {s.host}:{s.port} ({s.workspace})</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!reuseId || !!busy || !available}
                className={primaryClass}
                onClick={() => action({ action: "reuseConnection", serverId: reuseId }, (data) => { setServerId(String(data.serverId)); setReuseId(""); setNotice("Connection verified and saved."); })}
              >
                <Plug size={16} />
                {busy === "reuseConnection" ? "Connecting..." : "Use connection"}
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!available) return;
              action(
                { action: "connect", name: name || config.host, config },
                (data) => {
                  setServerId(String(data.serverId));

                  setConfig((c) => ({ ...c, password: "" }));
                  setNotice(
                    String(data.warning || "Connection verified and saved."),
                  );
                },
              );
            }}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label className="space-y-1 text-sm">
              Connection name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-sm">
              Database type
              <select
                value={config.dialect}
                onChange={(e) => {
                  const dialect = e.target.value as SourceConfig["dialect"];
                  setConfig((c) => ({
                    ...c,
                    dialect,
                    port:
                      dialect === "sqlserver"
                        ? 1433
                        : dialect === "mysql"
                          ? 3306
                          : 5432,
                    database: "",
                  }));
                }}
                className={inputClass}
              >
                <option value="sqlserver">SQL Server</option>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Host / IP
              <input
                required
                value={config.host}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, host: e.target.value }))
                }
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-sm">
              Port
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={config.port}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, port: Number(e.target.value) }))
                }
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-sm">
              Username
              <input
                required
                autoComplete="off"
                value={config.username}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, username: e.target.value }))
                }
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-sm">
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={config.password}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, password: e.target.value }))
                }
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-sm">
              Database
              <input
                required
                value={config.database}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, database: e.target.value }))
                }
                className={inputClass}
              />
            </label>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.tls}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, tls: e.target.checked }))
                  }
                />
                TLS encryption
              </label>
              {config.dialect === "sqlserver" && (
                <label className="flex items-start gap-2 text-xs text-amber-800">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={config.trustServerCertificate}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        trustServerCertificate: e.target.checked,
                      }))
                    }
                  />
                  Trust self-signed certificate (disables certificate
                  verification)
                </label>
              )}
              <button disabled={!!busy || !available} className={primaryClass}>
                <Plug size={16} />
                {busy === "connect" ? "Connecting..." : "Connect & save"}
              </button>
            </div>
          </form>
        </section>
        <section className="border-b border-zinc-200 pb-7">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Database size={18} />
            Database discovery
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
              <span>Saved server</span>
              <select
                className={inputClass}
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value);


                }}
              >
                <option value="">Select server</option>
                {setup.servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.dialect} · {s.host}:{s.port}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!serverId || !!busy}
              className={`${primaryClass} h-10`}
              onClick={() =>
                action({ action: "discover", serverId }, (data) => {
                  chooseSource(String(data.sourceId));
                  setNotice("Database objects discovered.");
                })
              }
            >
              <Database size={16} />
              {busy === "discover" ? "Discovering..." : "Discover objects"}
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {setup.sources.map((s) => (
              <div key={s.id} className="inline-flex items-stretch gap-1">
                <button
                  disabled={!!busy}
                  onClick={() => chooseSource(s.id)}
                  className={`${buttonClass} ${s.id === sourceId ? "border-rose-400 bg-rose-50 text-rose-800" : ""}`}
                >
                  <Database size={15} />
                  {s.database}
                  <span className="text-xs text-zinc-500">
                    {setup.servers.find((v) => v.id === s.serverId)?.name}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  title={`Remove ${s.database} from this workspace`}
                  aria-label={`Remove ${s.database} from ${setup.servers.find((v) => v.id === s.serverId)?.name || "saved server"}`}
                  className={`${buttonClass} text-red-700 hover:border-red-300 hover:bg-red-50`}
                  onClick={() => {
                    const count = setup.tools.filter(
                      (t) => t.sourceId === s.id,
                    ).length;
                    if (
                      !window.confirm(
                        `Remove ${s.database} from this workspace? This deletes its saved schema, ${count} tools, tool versions and test history. Existing conversations and report snapshots remain, but their queries will no longer run. The server connection and real database are NOT deleted or changed. This cannot be undone.`,
                      )
                    )
                      return;
                    action({ action: "removeSource", sourceId: s.id }, () => {
                      if (sourceId === s.id) chooseSource("");
                      setNotice(
                        `${s.database} removed from this workspace. The real database is unchanged.`,
                      );
                    });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
        {source && (
          <>
            <section className="border-b border-zinc-200 pb-7">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">
                  Objects · {source.database}
                </h2>
                <input
                  aria-label="Search database objects"
                  placeholder="Search objects"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`${inputClass} max-w-64`}
                />
              </div>
              <div className="max-h-80 overflow-y-auto border-y border-zinc-200 bg-white">
                {source.catalog.objects
                  .filter((o) =>
                    o.id.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((o) => (
                    <div key={o.id} className="border-b border-zinc-100">
                      <div className="flex items-center justify-between gap-3 px-3 py-3">
                        <label className="flex min-w-0 items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            disabled={!!busy || o.kind === "procedure"}
                            checked={!!selected[o.id]?.length}
                            onChange={(e) =>
                              setSelected((s) => {
                                const next = { ...s };
                                if (e.target.checked)
                                  next[o.id] = o.columns
                                    .filter((c) => !c.restricted)
                                    .map((c) => c.name);
                                else delete next[o.id];
                                return next;
                              })
                            }
                          />
                          <span className="break-all font-medium">{o.id}</span>
                        </label>
                        <span className="flex shrink-0 items-center gap-3 text-xs text-zinc-500">
                          {o.kind === "procedure"
                            ? "Procedure · review only"
                            : `${o.kind} · ${o.columns.length} columns`}
                          <button
                            title="Inspect columns or parameters"
                            onClick={() =>
                              setExpanded(expanded === o.id ? null : o.id)
                            }
                            className="rounded p-1 hover:bg-zinc-100"
                          >
                            <Pencil size={15} />
                          </button>
                        </span>
                      </div>
                      {expanded === o.id && (
                        <div className="border-t border-zinc-100 px-4 py-3">
                          {o.kind === "procedure" ? (
                            <pre className="overflow-auto whitespace-pre-wrap text-xs">
                              {JSON.stringify(o.parameters, null, 2)}
                            </pre>
                          ) : (
                            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                              {o.columns.map((c) => (
                                <label
                                  key={c.name}
                                  className="flex items-center gap-2 text-xs"
                                >
                                  <input
                                    type="checkbox"
                                    disabled={!!busy || c.restricted}
                                    checked={
                                      selected[o.id]?.includes(c.name) || false
                                    }
                                    onChange={(e) =>
                                      setSelected((s) => ({
                                        ...s,
                                        [o.id]: e.target.checked
                                          ? [...(s[o.id] || []), c.name]
                                          : (s[o.id] || []).filter(
                                              (n) => n !== c.name,
                                            ),
                                      }))
                                    }
                                  />
                                  <span className="break-all">{c.name}</span>
                                  <span className="text-zinc-500">
                                    {c.dataType}
                                    {c.isPrimaryKey ? " · PK" : ""}
                                    {c.restricted ? " · protected" : ""}
                                  </span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
              <div className="mt-3 text-xs text-zinc-500">
                {Object.values(selected).filter((c) => c.length).length}{" "}
                selected objects ·{" "}
                {
                  source.catalog.relationships.filter((r) => r.targetUnique)
                    .length
                }{" "}
                verified relationships
              </div>
              <div className="mt-5 space-y-3">
                {(error.startsWith("Tool generation failed.") ||
                  error.startsWith("Tools were generated and saved,")) && (
                  <div
                    role="alert"
                    className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                  >
                    {error}
                  </div>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I approve sending selected object names, columns,
                  relationships to OpenAI. No rows or credentials are included.
                </label>
                {!busy && resumableJob && <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600"><span>Completed schema groups are saved.</span><button type="button" className={buttonClass} onClick={()=>action({action:'resumeGeneration',jobId:resumableJob},()=>setNotice('Generation completed; drafts saved for review.'))}>Resume generation</button></div>}
                {busy === 'generate' && <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
                  <span>{generationProgress} · {generationElapsed}s elapsed</span>
                  <button type="button" className={buttonClass} onClick={cancelJob}>Cancel generation</button>
                </div>}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    className={primaryClass}
                    disabled={
                      !!busy ||
                      !consent ||
                      !Object.values(selected).some((c) => c.length) ||
                      !setup.generationModel
                    }
                    onClick={() =>
                      action(
                        {
                          action: "generate",
                          sourceId,
                          selected: Object.entries(selected)
                            .filter(([, c]) => c.length)
                            .map(([id, columns]) => ({ id, columns })),
                          request: "",
                          consent,
                        },
                        (data) =>
                          setNotice(generationSummary(data)),
                      )
                    }
                  >
                    <Sparkles size={16} />
                    {busy === "generate"
                      ? "Generating..."
                      : "Generate tool suggestions"}
                  </button>
                  <span className="text-xs text-zinc-500">
                    Model:{" "}
                    {setup.generationModel ||
                      "TOOL_GENERATION_MODEL not configured"}
                  </span>
                </div>
              </div>
            </section>
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">
                  Tool Registry · {tools.length}
                </h2>
                <div className="flex flex-wrap gap-2">
                <button disabled={!!busy || !tools.some((t) => t.status !== 'approved')} className={primaryClass}
                  onClick={() => action({ action: 'approveAll', sourceId }, () => setNotice('All tools for this database approved and saved.'))}>
                  <Check size={16} />{busy === 'approveAll' ? 'Approving...' : 'Approve All'}
                </button>
                <button
                  disabled={!!busy}
                  onClick={newTool}
                  className={buttonClass}
                >
                  <Plus size={16} />
                  Add tool
                </button>
                <button
                  disabled={!!busy || !tools.length}
                  className={buttonClass}
                  onClick={() => {
                    if (!window.confirm(`Delete all ${tools.length} tools for this database, including approved ones? They will be removed from chat until you generate and approve tools again.`)) return;
                    action({ action: 'removeAllTools', sourceId }, (data) => setNotice(`${data.removed ?? 0} tools deleted. Generate tool suggestions to create them again.`));
                  }}
                >
                  <Trash2 size={16} />
                  {busy === 'removeAllTools' ? 'Deleting...' : 'Delete all tools'}
                </button>
                </div>
              </div>
              <p className="mb-3 text-xs text-zinc-500">Approve tools individually or all at once. Testing is optional. Mark an approved tool Not Approved to remove it from chat.</p>
              {!tools.length && (
                <p className="py-5 text-sm text-zinc-500">
                  No tools saved for this database.
                </p>
              )}
              <div className="divide-y divide-zinc-200">
                {tools.map((t) => (
                  <div
                    key={t.id}
                    className="flex flex-wrap items-center justify-between gap-4 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-all text-sm font-semibold">
                          {t.definition.name}
                        </h3>
                        <span
                          className={`text-xs ${t.status === "approved" ? "text-rose-800" : "text-zinc-500"}`}
                        >
                          {t.status === "approved" ? "Approved" : "Not Approved"} · v{t.version} · {t.definition.capabilities ? "Generic query tool" : "Report definition"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-zinc-600">
                        {t.definition.description}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {t.definition.base} · {t.definition.mode} ·{" "}
                        {t.definition.filters.length} filters
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        disabled={!!busy}
                        title="Review or edit tool plan"
                        className={buttonClass}
                        onClick={() =>
                          setEditor({
                            name:
                              t.status === "approved"
                                ? "Copy approved tool with a new name"
                                : "Edit tool",
                            json: JSON.stringify(
                              {
                                ...t.definition,
                                ...(t.status === "approved"
                                  ? {
                                      name: `${t.definition.name.slice(0, 55)}_copy`,
                                    }
                                  : {}),
                              },
                              null,
                              2,
                            ),
                          })
                        }
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        disabled={!!busy}
                        className={buttonClass}
                        onClick={() => {
                          setTesting(t);
                          setValues({});
                          setPreview(null);
                        }}
                      >
                        <Play size={16} />
                        Test
                      </button>
                      <button
                        disabled={!!busy}
                        className={t.status === "approved" ? primaryClass : buttonClass}
                        aria-pressed={t.status === "approved"}
                        title={t.status === "approved" ? "Click to mark Not Approved" : "Click to approve without testing"}
                        onClick={() =>
                          action({ action: t.status === "approved" ? "unapprove" : "approve", toolId: t.id }, () =>
                            setNotice(t.status === "approved" ? "Tool marked Not Approved and removed from chat." : "Tool approved and saved."),
                          )
                        }
                      >
                        <Check size={16} />
                        {t.status === "approved" ? "Approved" : "Not Approved"}
                      </button>
                      <button
                        disabled={!!busy}
                        title="Remove tool"
                        className={buttonClass}
                        onClick={() => {
                          if (window.confirm(`Remove ${t.definition.name}?`))
                            action({ action: "removeTool", toolId: t.id });
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {editor && (
                <div className="mt-5 rounded-md border border-zinc-300 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{editor.name}</h3>
                    <button
                      title="Close editor"
                      onClick={() => setEditor(null)}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <ToolPlanEditor
                    key={editor.json}
                    initial={JSON.parse(editor.json)}
                    catalog={source.catalog}
                    busy={!!busy}
                    onSave={(definition) =>
                      action({ action: "draft", sourceId, definition }, () => {
                        setEditor(null);
                        setNotice("Draft saved. You can approve now; testing is optional.");
                      })
                    }
                  />
                </div>
              )}
              {testing && (
                <div className="mt-5 rounded-md border border-zinc-300 bg-white p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="break-all text-sm font-semibold">
                      Test · {testing.definition.name}
                    </h3>
                    <button
                      title="Close test"
                      onClick={() => {
                        setTesting(null);
                        setPreview(null);
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  {testing.definition.capabilities ? (
                    <ToolTestControls
                      key={`${testing.id}:${testing.version}`}
                      definition={testing.definition}
                      catalog={source.catalog}
                      busy={!!busy}
                      onRun={(parameters) => {
                        setPreview(null);
                        action({ action: "test", toolId: testing.id, parameters }, (data) => {
                          setPreview(data.preview as Preview);
                          setNotice("Read-only test succeeded.");
                        });
                      }}
                    />
                  ) : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {testing.definition.filters
                      .filter(
                        (f) => !["is_null", "not_null"].includes(f.operator),
                      )
                      .map((f) => (
                        <label key={f.parameter} className="space-y-1 text-sm">
                          {f.parameter}
                          {f.required ? " *" : ""}
                          <input
                            className={inputClass}
                            value={values[f.parameter] || ""}
                            onChange={(e) =>
                              setValues((v) => ({
                                ...v,
                                [f.parameter]: e.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                  </div>}
                  {!testing.definition.capabilities && <button
                    disabled={!!busy}
                    className={`${primaryClass} mt-3`}
                    onClick={() =>
                      action(
                        {
                          action: "test",
                          toolId: testing.id,
                          parameters: Object.fromEntries(
                            Object.entries(values).filter(([, v]) => v !== ""),
                          ),
                        },
                        (data) => {
                          setPreview(data.preview as Preview);
                          setNotice("Read-only test succeeded.");
                        },
                      )
                    }
                  >
                    <Play size={16} />
                    {busy === "test" ? "Testing..." : "Run read-only test"}
                  </button>}
                  {preview && (
                    <>
                      <p className="my-3 text-xs text-zinc-500">
                        {preview.rows.length} preview rows
                        {preview.hasMore
                          ? " · more results available"
                          : ""} · {preview.elapsedMs} ms · {preview.scope}
                      </p>
                      <div className="max-h-80 overflow-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr>
                              {Object.keys(preview.rows[0] || {}).map((key) => (
                                <th
                                  key={key}
                                  className="whitespace-nowrap border-b bg-zinc-50 p-2"
                                >
                                  {key}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.map((row, index) => (
                              <tr key={index}>
                                {Object.values(row).map((value, col) => (
                                  <td
                                    key={col}
                                    className="max-w-64 break-words border-b p-2"
                                  >
                                    {value === null
                                      ? "NULL"
                                      : typeof value === "object"
                                        ? JSON.stringify(value)
                                        : String(value)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!preview.rows.length && (
                          <p className="py-4 text-sm">
                            Query succeeded with no matching records.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
              {tools.some((t) => t.status === "approved") && (
                <div className="mt-6 border-t border-zinc-200 pt-4">
                  <span className="text-xs font-medium text-zinc-500">
                    WORKSPACE MCP ENDPOINT
                  </span>
                  <p className="mt-1 break-all font-mono text-xs">
                    /api/workspaces/{id}/tools/mcp
                  </p>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </WorkspacePage>
  );
}
