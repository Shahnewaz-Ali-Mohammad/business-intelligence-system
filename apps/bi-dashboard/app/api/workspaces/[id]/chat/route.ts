import { enterAccess } from '@/lib/access/data-scope.mjs';
import { runWithAccess, AccessDenied } from '@/lib/access/data-scope.mjs';
import { audit } from '@/lib/access/access-db';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import {groundReferenceLabels} from '@/lib/tool-setup/reference-binding.mjs';
import {assertRelevantLabels,labelRecovery,relevantLabelEvidence} from '@/lib/tool-setup/label-recovery.mjs';
import {validateExecutionRequest} from '@/lib/tool-setup/execution-request.mjs';
import {candidateTools,requiresDetailedReport} from '@/lib/tool-setup/chat-planning.mjs';
import { ChatOpenAI } from '@langchain/openai';
import { workspaceEntry } from '../../../../../scripts/chat/workspace-entry.mjs';
import { writeAnalyticalInsight } from '../../../../../scripts/lib/analytical-insight.mjs';
import {isAggregateRequest,validateReportSelection} from '@/lib/tool-setup/request-fields.mjs';
import {resolveSavedRequest,missingReportDecision} from '@/lib/tool-setup/lookup-resolution.mjs';
import {addRequestedCalculations,assertNamedColumns} from '@/lib/tool-setup/analysis-intent.mjs';
import {devLog} from '@/lib/dev-log.mjs';
import {compileTool} from '@/lib/tool-setup/model.mjs';
import {savedReportTools} from '@/lib/tool-setup/saved-report-tools.mjs';
import {recordNarrative,requestedRecordArguments,validateRecordPopulation} from '@/lib/tool-setup/record-presentation.mjs';
import {reportContext} from '@/lib/tool-setup/report-context.mjs';
import {executeOnce} from '@/lib/tool-setup/request-execution.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createToolServer, mcpToolName } from '@/lib/tool-setup/mcp.mjs';
import { runWorkspaceAgent } from '../../../../../scripts/chat/agent.mjs';
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspace } from "@/lib/workspaces/workspaceDb";
import { listSetup, getTool, getSource } from "@/lib/tool-setup/store";
import {
  discoverDatabase,
  executeTool,
  summarizeTool,
} from "@/lib/tool-setup/connectors.mjs";
import { getAppDb } from "@/lib/db/app-db";
import {
  createRunEvents,
  eventFrame,
  errorCode,
} from "../../../../../scripts/lib/ag-ui-stream.mjs";

export const runtime = "nodejs";
export const maxDuration = 180;
const Input = z
  .object({
    message: z.string().trim().min(1).max(4000),
    sourceId: z.string().min(1),
    sessionId: z.number().int().positive().optional(),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(4000),
        }),
      )
      .max(10)
      .default([]),
  })
  .strict();
const turns = new Map<number, number[]>();
function readableField(value: string) {
  return value
    .replace(/^[^:]+:/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}
function queryPlan(value: unknown) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}
function filterFields(node: unknown, fields = new Set<string>()) {
  if (!node || typeof node !== 'object') return fields;
  const filter = node as {field?: unknown; and?: unknown[]; or?: unknown[]; not?: unknown};
  if (typeof filter.field === 'string') fields.add(filter.field);
  for (const child of [...(filter.and || []), ...(filter.or || [])]) filterFields(child, fields);
  filterFields(filter.not, fields);
  return fields;
}
function preserveFollowUpFilters(message: string, current: string, previous: Record<string, unknown> | null) {
  if (!previous?.where || !/^(?:just|only|now|and|also|what about|how about)\b|\b(?:those|these|them|ones|same)\b/i.test(message.trim())) return current;
  const plan = queryPlan(current);
  if (!plan) return current;
  const currentFields = filterFields(plan.where);
  const retained: unknown[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const filter = node as {field?: unknown; and?: unknown[]; or?: unknown[]; not?: unknown};
    if (typeof filter.field === 'string') { if (!currentFields.has(filter.field)) retained.push(filter); return; }
    for (const child of [...(filter.and || []), ...(filter.or || [])]) visit(child);
    if (filter.not) visit(filter.not);
  };
  visit(previous.where);
  if (!retained.length) return current;
  plan.where = {and: [...retained, ...(plan.where ? [plan.where] : [])]};
  return JSON.stringify(plan);
}
function aggregateNarrative(rows: Record<string, unknown>[], mode: string, query: unknown) {
  if (mode !== 'aggregate' || !rows.length) return '';
  const keys = Object.keys(rows[0]);
  const numericKey = (k: string) => !k.includes(':') && rows.every((r) => r[k] == null || Number.isFinite(Number(r[k])));
  const metric = keys.find(numericKey) || keys.at(-1)!;
  const labels = keys.filter((k) => k.includes(':'));
  const plan = queryPlan(query);
  const operation = Array.isArray((plan as {metrics?: unknown[]})?.metrics)
    ? String(((plan as {metrics: Array<{operation?: unknown}>}).metrics[0]?.operation) || '')
    : '';
  const text = (v: unknown) => v == null ? 'Missing' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/T00:00:00(?:\.000)?Z$/, '');
  const name = (r: Record<string, unknown>) => labels.map((k) => text(r[k])).join(' / ') || 'All';
  const value = (r: Record<string, unknown>) => Number(r[metric]) || 0;
  const metricName = readableField(metric) || (operation === 'count' ? 'count' : 'value');
  if (!labels.length && rows.length === 1) {
    const formatted = value(rows[0]).toLocaleString();
    if (metricName.startsWith('total ')) return `There are ${formatted} ${metricName.slice(6)}.`;
    if (metricName === 'record count' || metricName === 'count') return `There are ${formatted} matching records.`;
    return `The ${metricName} is ${formatted}.`;
  }
  const ranked = [...rows].sort((a, b) => value(b) - value(a));
  const highest = ranked[0];
  const lowest = ranked.at(-1)!;
  const next = ranked.slice(1, 3);
  const following = next.length
    ? ` Next are ${next.map((row) => `${name(row)} with ${value(row).toLocaleString()}`).join(' and ')}.`
    : '';
  return `Across ${rows.length.toLocaleString()} groups, ${name(highest)} has the highest ${metricName} at ${value(highest).toLocaleString()}.${following} ${name(lowest)} has the lowest at ${value(lowest).toLocaleString()}.`;
}
function sourceName(setup: { sources: { id: string; name?: string; database?: string }[] }, sourceId: string) {
  const s = setup.sources.find((x) => x.id === sourceId);
  return s?.name || s?.database || '';
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await requireAccess('chat.use'); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  const workspace = user && (await getWorkspace(id));
  if (
    !user ||
    !workspace ||
    !canOpenWorkspace(guard.access) ||
    id === "isp-default"
  )
    return NextResponse.json(
      { error: "Workspace unavailable." },
      { status: 403 },
    );
  const recent = (turns.get(user.id) || []).filter(
    (t) => Date.now() - t < 60000,
  );
  if (recent.length >= 10)
    return NextResponse.json(
      { error: "Please wait before asking again." },
      { status: 429 },
    );
  recent.push(Date.now());
  turns.set(user.id, recent);
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Enter a question and choose a database." },
      { status: 400 },
    );
  const input = parsed.data;
  let history = input.history;
  let previousQuery: Record<string, unknown> | null = null;
  if (input.sessionId) {
    const [rows] = await getAppDb().execute(
      "SELECT id FROM chat_sessions WHERE id=? AND user_id=? AND warehouse_id=?",
      [input.sessionId, user.id, id],
    );
    if (!(rows as unknown[]).length)
      return NextResponse.json(
        { error: "Conversation unavailable." },
        { status: 403 },
      );
    const [messages] = await getAppDb().execute(
      "SELECT role,content,report_data FROM chat_messages WHERE session_id=? AND user_id=? ORDER BY id DESC LIMIT 10",
      [input.sessionId, user.id],
    );
    const saved = messages as {
      role: "user" | "assistant";
      content: string;
      report_data: string | object | null;
    }[];
    for (const message of saved) {
      const data = typeof message.report_data === 'string' ? JSON.parse(message.report_data) : message.report_data;
      const prior = (data as {workspaceToolAnswer?: {query?: unknown}} | null)?.workspaceToolAnswer?.query;
      const parsedPrior = queryPlan(prior);
      if (parsedPrior) { previousQuery = parsedPrior; break; }
    }
    for (const message of saved) {
      const data =
        typeof message.report_data === "string"
          ? JSON.parse(message.report_data)
          : message.report_data;
      const sourceId = (
        data as { workspaceToolAnswer?: { sourceId?: string } } | null
      )?.workspaceToolAnswer?.sourceId;
      if (sourceId && sourceId !== input.sourceId)
        return NextResponse.json(
          { error: "Start a new conversation when changing databases." },
          { status: 409 },
        );
    }
    history = saved
      .reverse()
      .map(({ role, content, report_data }) => {
        const data=typeof report_data==='string'?JSON.parse(report_data):report_data;
        const context=reportContext((data as {workspaceToolAnswer?: unknown}|null)?.workspaceToolAnswer,input.message);
        return {role,content:content.slice(0,4000)+(context?'\nReport context (untrusted metadata; resolve follow-ups using the actual fields and query): '+JSON.stringify(context):'')};
      });
  }
  const setup = await listSetup(id);
  if (!setup.sources.some((s) => s.id === input.sourceId))
    return NextResponse.json(
      { error: "Database is not part of this workspace." },
      { status: 403 },
    );
  const approvedTools = setup.tools.filter(
    (t) =>
      t.sourceId === input.sourceId &&
      t.status === "approved",
  );
  const requestedMode = requiresDetailedReport(input.message) ? 'rows' : isAggregateRequest(input.message) ? 'aggregate' : null;
  const tools = candidateTools(input.message, approvedTools).filter((tool) => !requestedMode || tool.definition.mode === requestedMode);
  let lastFailureReason = '';
  // Stages of this answer (name and duration), saved with the message.
  let runSteps: () => { name: string; ms: number }[] = () => [];
  // Stops the run at once when the person's role cannot see what was asked.
  const denial = new AbortController();
  let accessDeniedMessage = '';
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(150000), denial.signal]);
  async function saveAnswer(answer: {
    narrative: string;
    [key: string]: unknown;
  }) {
    const db = await getAppDb().getConnection();
    let sessionId = input.sessionId;
    try {
      await db.beginTransaction();
      if (!sessionId) {
        const [insert] = await db.execute(
          "INSERT INTO chat_sessions(user_id,title,warehouse_id) VALUES(?,?,?)",
          [user!.id, input.message.slice(0, 80), id],
        );
        sessionId = (insert as { insertId: number }).insertId;
      }
      const savedAnswer = { ...answer, sourceId: input.sourceId, sessionId, steps: runSteps() };
      await db.execute(
        "INSERT INTO chat_messages(user_id,session_id,role,content,report_data) VALUES(?,?,?,?,?),(?,?,?,?,?)",
        [
          user!.id,
          sessionId,
          "user",
          input.message,
          null,
          user!.id,
          sessionId,
          "assistant",
          answer.narrative,
          JSON.stringify({ workspaceToolAnswer: savedAnswer }),
        ],
      );
      await db.execute("UPDATE chat_sessions SET updated_at=NOW() WHERE id=?", [
        sessionId,
      ]);
      await db.commit();
      return savedAnswer;
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    // The person's access travels with the whole run, including tool calls
    // made by the agent, so every query in it is filtered for them.
    start: (out) => runWithAccess(guard.access, async () => {
      const run = createRunEvents(
        (event: unknown) => out.enqueue(encoder.encode(eventFrame(event))),
        {
          threadId: id,
          runId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
        },
      );
      runSteps = () => run.steps();
      try {
        // 2026-10-13: same LangGraph pipeline as the original chat
        // (scripts/chat/agent.mjs -> getBiGraph: draft -> critique -> retry).
        // Only the tools differ: this workspace's approved, generated MCP
        // tools. Approval, version and schema checks run before every call.
        const requestedLookup=resolveSavedRequest(input.message,setup.tools.filter(t=>t.sourceId===input.sourceId));
        if(requestedLookup&&requestedLookup.chosen.status!=='approved'){
          run.finish(await saveAnswer({narrative:'A saved report already supports this lookup. Approve it in Settings, then retry.',rows:[],hasMore:false}));return;
        }
        if (!tools.length) {
          run.finish(await saveAnswer({ narrative: approvedTools.length ? 'No approved tool supports the requested report type. A record list cannot be substituted with an aggregate, or vice versa.' : 'Approve tools for this database in Settings before asking data questions.', rows: [], hasMore: false }));
          return;
        }
        run.progress("Understanding your question");
        // Same entry step as the original chat: greetings, thanks and
        // unrelated questions are answered before any tool runs.
        const entrySource = setup.sources.find((s) => s.id === input.sourceId);
        const entry = await workspaceEntry({
          llm: new ChatOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-4o', temperature: 0, timeout: 30000, maxRetries: 1 }),
          message: input.message,
          history,
          database: sourceName(setup, input.sourceId) || workspace!.name,
          topics: (entrySource?.catalog?.objects || []).slice(0, 60).map((o: { name: string; columns: { name: string; restricted?: boolean }[] }) => ({ name: o.name, columns: o.columns.filter((col) => !col.restricted).slice(0, 40).map((col) => col.name) })),
          signal,
        });
        if (entry.route !== 'agent') {
          const narrative = entry.narrative || 'What would you like to know about this database?';
          run.text(narrative);
          run.finish(await saveAnswer({ narrative, rows: [], hasMore: false }));
          return;
        }
        const source = await getSource(id, input.sourceId);
        const catalog = await discoverDatabase(source.config);
        const queryFor = (definition: { capabilities?: unknown }, args: Record<string, unknown>) =>
          definition.capabilities
            ? (typeof args.query === 'string' ? args.query : JSON.stringify({}))
            : JSON.stringify({ values: args });
        const approvedNow = async (toolId: string) => {
          const latest = await getTool(id, toolId);
          if (latest.status !== 'approved' || latest.source_id !== input.sourceId) throw new Error('Approval changed');
          if (catalog.fingerprint !== latest.catalog_fingerprint) throw new Error('Schema changed');
          return latest;
        };
        const executeReferenceLookup=async(tool:{id:string},query:string)=>{const current=await approvedNow(tool.id);return executeTool(source.config,current.definition,catalog,{query},20);};
        const verifiedLabels=await relevantLabelEvidence({message:input.message,approvedTools,catalog,execute:executeReferenceLookup});
        // What the AI reads: database-computed statistics over the FULL
        // result, never row dumps (rows only for tiny results; aggregate
        // groups are themselves database summaries).
        const completedExecutions: {toolId: string; query: string; result: Awaited<ReturnType<typeof executeTool>>; summary: Awaited<ReturnType<typeof summarizeTool>> | null}[] = [];
        const executionCache = new Map();
        let executionFailed=false;
        let executionFailureReason='';
        const tableName = (base: string) => catalog.objects.find((object: { id: string; name?: string }) => object.id === base)?.name || base;
        const server = createToolServer(tools, async (chosen: { id: string }, args: Record<string, unknown>) => {
          const picked = tools.find((t) => t.id === chosen.id);
          const call = run.toolStart({
            name: picked?.definition.name || 'query',
            label: picked ? `Querying ${tableName(picked.definition.base)}${picked.definition.mode === 'aggregate' ? ' (summary)' : ''}` : 'Querying the database',
            args,
          });
          try {
          let latest = await approvedNow(chosen.id);
          if (!latest.definition.capabilities) validateReportSelection(input.message,latest.definition,tools);
          let parameters = { query: addRequestedCalculations(input.message,latest.definition,queryFor(latest.definition, requestedRecordArguments(input.message,latest.definition,args)),catalog) };
          parameters.query=groundReferenceLabels(latest.definition,catalog,parameters.query);
          parameters.query=preserveFollowUpFilters(input.message,parameters.query,previousQuery);
          // If the chosen query tool cannot run this plan (for example the
          // fields are only reachable from another table's tool), run the same
          // plan on the approved query tool that can.
          if (latest.definition.capabilities) {
            try { compileTool(latest.definition, catalog, source.config.dialect, parameters); }
            catch (error) {
              const plan = JSON.parse(parameters.query);
              const used = [...(plan.columns && plan.columns !== '*' ? plan.columns : []), ...(plan.groupBy || []), ...(plan.metrics || []).map((m: {field: string | null}) => m.field).filter(Boolean)];
              const alternatives = tools.filter((t) => t.id !== latest.id && t.definition.capabilities && t.definition.mode === latest.definition.mode)
                .sort((a, b) => Number(used.some((f) => f.startsWith(b.definition.base + ':'))) - Number(used.some((f) => f.startsWith(a.definition.base + ':'))));
              let rerouted = false;
              for (const alternative of alternatives) {
                try { compileTool(alternative.definition, catalog, source.config.dialect, parameters); latest = await approvedNow(alternative.id); rerouted = true; devLog('rerouted', {from: chosen.id, to: alternative.definition.name}); break; } catch {}
              }
              if (!rerouted) throw error;
            }
          }
          // Only tables with approved tools count as "the table the user named".
          const approvedCatalog={...catalog,objects:catalog.objects.filter((o:{id:string})=>tools.some((t)=>t.definition.base===o.id))};
          try { validateRecordPopulation(input.message,latest.definition,approvedCatalog); }
          catch (error) {
            // The question names another table: answer it with that table's query tool.
            const wanted = error instanceof Error ? error.message.match(/^Use the requested table (\S+);/)?.[1] : undefined;
            const target = wanted && tools.find((t) => t.definition.base === wanted && t.definition.capabilities && t.definition.mode === latest.definition.mode);
            if (!target) throw error;
            const plan = latest.definition.capabilities ? JSON.parse(parameters.query) : {};
            const own = (f: string) => f.startsWith(wanted + ':');
            latest = await approvedNow(target.id);
            parameters = { query: addRequestedCalculations(input.message, latest.definition, JSON.stringify(latest.definition.mode === 'rows' ? { ...plan, columns: Array.isArray(plan.columns)&&plan.columns.some(own)?plan.columns:'*' } : { ...plan }), catalog) };
            devLog('rerouted', { reason: 'named table', to: target.definition.name });
          }
          assertNamedColumns(input.message,latest.definition,parameters.query);
          assertRelevantLabels(parameters.query,verifiedLabels);
          validateExecutionRequest(input.message,latest.definition,catalog,source.config.dialect,parameters);
          devLog('tool-call', {tool: latest.definition.name, parameters});
          // Statistics are best-effort: if they cannot be computed, the agent
          // still gets a small preview instead of a failed call.
          const { result: preview, summary } = await executeOnce(executionCache, JSON.stringify([latest.id, latest.version, parameters.query]), async () => {
          const preview = await executeTool(source.config, latest.definition, catalog, parameters, 200, 0, { maxLimit: 200 });
          run.state({ preview: {
            title: catalog.objects.find((object: { id: string }) => object.id === latest.definition.base)?.name || 'Results',
            mode: latest.definition.mode,
            ...(preview.hasMore ? {} : { totalCount: preview.rows.length }),
            rows: preview.rows.slice(0, 8),
          } });
          let summary: Awaited<ReturnType<typeof summarizeTool>> | null = null;
          try { summary = await summarizeTool(source.config, latest.definition, catalog, parameters); }
          catch (error) { console.error('[workspace tool] statistics failed:', error instanceof Error ? error.message : error); }
          return { result: preview, summary };
          });
          const labelEvidence=await labelRecovery({message:input.message,definition:latest.definition,query:parameters.query,result:preview,approvedTools,catalog,execute:async(tool:{id:string},query:string)=>{const current=await approvedNow(tool.id);return executeTool(source.config,current.definition,catalog,{query},12);}});
          if(labelEvidence.length)throw new Error('Use the verified label matches to interpret the employee wording and retry the requested report: '+JSON.stringify(labelEvidence)+'. The literal phrase matched no rows; that does not establish that the business category is absent.');
          const population = summary ? Number(summary.population) || 0 : 0;
          completedExecutions.push({toolId: latest.id, query: parameters.query, result: preview, summary});
          run.toolEnd(call, { rows: summary ? population : preview?.rows.length });
          return {
            tool: latest.definition.name,
            mode: latest.definition.mode,
            summary,
            rows: preview.rows.slice(0, 50), rowsAreComplete: !preview.hasMore && preview.rows.length <= 50,
            note: summary
              ? `Grain: ${summary.scope}. Available figures are computed by the database over ${population.toLocaleString()} matching ${latest.definition.mode === 'aggregate' ? 'groups' : 'records'}. The user sees the rows in the table; do not list them.`
              : 'Full-population statistics are unavailable. Only a bounded preview is available; do not infer a total, average, median, extrema, or absence of records for the full dataset from this preview. The user sees the rows in the table; do not list them.',
          };
          } catch (error) {
            devLog('tool-error', {args, error: error instanceof Error ? error.message : String(error)});
            run.toolEnd(call, { ok: false, note: 'This attempt could not run; trying another way' });
            executionFailed = true;
            if (error instanceof AccessDenied) { accessDeniedMessage = error.message; denial.abort(); }
            const reason = error instanceof Error ? error.message : '';
            if (/^(Use the requested|The requested|Verified request|Query exceeds|Join |Relationships |Multiple relationship|No approved relationship|This request|Choose the stored)/.test(reason)) { executionFailureReason = reason; lastFailureReason = reason; }
            throw error;
          }
        }, catalog);
        const client = new Client({ name: 'bi-workspace-chat', version: '1.0.0' });
        const [left, right] = InMemoryTransport.createLinkedPair();
        await server.connect(right);
        await client.connect(left);
        let agentResult;
        try {
          const direct=resolveSavedRequest(input.message,tools);
          if(direct){
            const name=mcpToolName(direct.chosen.sourceId,direct.chosen.definition.name);
            const result=await client.callTool({name,arguments:direct.parameters},undefined,{signal});
            if(result.isError)throw new Error('The saved lookup could not execute. No missing capability has been inferred.');
            agentResult={structured:{intent:'answer',title:direct.chosen.definition.mode==='aggregate'?'Grouped count':'Record details',narrative:''},toolCalls:[{name,args:direct.parameters}],grounded:true};
          }else{
            const exposed = await loadMcpTools('bi-workspace-tools', client);
            for (const t of exposed as {name:string;schema:unknown;verboseParsingErrors?:boolean}[]) { t.verboseParsingErrors = true; if (t.name.includes('aggregate')) devLog('schema '+t.name, JSON.stringify(t.schema).slice(0,30000)); }
            const reusableNames=new Set(tools.filter(t=>t.definition.capabilities).map(t=>mcpToolName(t.sourceId,t.definition.name)));
            const approvedFields=new Set(approvedTools.flatMap(t=>t.definition.capabilities?.fields||[]));
            const valueFields=catalog.objects.flatMap((o:{id:string;columns:{name:string;dataType:string}[]})=>o.columns.filter(c=>/char|text/i.test(c.dataType)&&approvedFields.has(o.id+':'+c.name)).map(c=>o.id+':'+c.name));
            const findValues=async(field:string,search?:string)=>{
              const candidates=approvedTools.filter(t=>t.definition.mode==='aggregate'&&t.definition.capabilities?.fields.includes(field));
              const chosen=candidates.find(t=>field.startsWith(t.definition.base+':'))||candidates[0];
              if(!chosen)throw new Error('No approved capability supports this reference field.');
              const latest=await approvedNow(chosen.id);
              const query=JSON.stringify({groupBy:[field],metrics:[{field:null,operation:'count',alias:'occurrences'}],...(search?{where:{field,operator:'contains',value:search}}:{}),limit:50});
              const result=await executeTool(source.config,latest.definition,catalog,{query},50);
              return {field,values:result.rows,hasMore:result.hasMore,note:'Use exact stored labels. This lookup does not fulfill the employee report request.'};
            };
            const lcTools = tools.some(t=>t.definition.template) ? [...savedReportTools(client,tools,{findValues,valueFields}),...exposed.filter(t=>reusableNames.has(t.name))] : exposed;
            const verifiedContext=verifiedLabels.length?'Verified stored labels required by this request: '+JSON.stringify(verifiedLabels)+'. Preserve prior report filters and include these exact label filters in the report query.':'';
            agentResult = await runWorkspaceAgent({message:input.message,history,workspaceName:sourceName(setup,input.sourceId)||workspace!.name,tools:lcTools,businessNotes:verifiedContext,signal,onProgress:(text:string)=>run.progress(text)});
          }
        } finally {
          await client.close().catch(() => {});
          await server.close().catch(() => {});
        }
        const structured = agentResult.structured;
        const gap=structured?.intent==='missing_capability' ? ('missingCapability' in structured?String(structured.missingCapability||''):'') : '';
        const decision=missingReportDecision({message:input.message,gap,registry:setup.tools.filter(t=>t.sourceId===input.sourceId),completed:completedExecutions.length,failed:executionFailed});
        if(gap && !completedExecutions.length && decision.kind!=='missing'){
          if(decision.kind==='execution_error')throw new Error(executionFailureReason||'Report execution failed; no missing capability has been inferred.');
          const narrative=decision.kind==='needs_approval'?'A saved report already supports this lookup. Approve it in Settings, then retry.':'Could not verify a missing report capability. No new tool generation is required based on this response; retry the existing report.';
          run.text(narrative);run.finish(await saveAnswer({narrative,rows:[],hasMore:false}));return;
        }
        if(gap && decision.kind==='missing'){
          // Offer generation; never start it automatically. The card's
          // "Generate missing report" button starts it when the user chooses.
          const narrative='No approved report or query tool can answer this yet. You can generate a report for it below, then approve it in Settings.';
          run.text(narrative);
          run.finish(await saveAnswer({narrative,rows:[],hasMore:false,missingScenario:{question:input.message,gap}}));
          return;
        }
        let narrativeText = structured?.narrative || 'Could not produce a grounded answer for this question.';
        // Render only a query that actually succeeded, never an attempted call
        // reconstructed from the agent message history.
        // When several queries ran, show the one matching the question's shape:
        // a summary for counts/totals/earliest/latest, otherwise the record list.
        const wantsSummary = /\b(how many|count|total|sum|average|avg|earliest|latest|oldest|newest|minimum|maximum|per|by|share|percent|growth|trend)\b/i.test(input.message);
        const modeOf = (e: {toolId: string}) => tools.find((t) => t.id === e.toolId)?.definition.mode;
        const completed = [...completedExecutions].reverse().find((e) => (modeOf(e) === 'aggregate') === wantsSummary) || completedExecutions.at(-1);
        if (!completed) {
          if (executionFailed || agentResult.toolCalls.some(call=>call.name==='run_saved_report')) throw new Error(executionFailureReason||'Every selected report execution failed; no verified report is available.');
          run.text(narrativeText);
          run.finish(await saveAnswer({ title: structured?.title, narrative: narrativeText, rows: [], hasMore: false }));
          return;
        }
        run.progress("Preparing the report");
        const current = await approvedNow(completed.toolId);
        const query = completed.query;
        // The chat shows at most 200 rows; the saved report pages through
        // every row and Export Excel downloads all of them.
        const result = completed.result;
        const summary = completed.summary ?? undefined;
        // Same insight step as the original chat: the answer is written from
        // database statistics over the FULL result (writeAnalyticalInsight),
        // never replaced by a fixed placeholder sentence.
        const countLine = current.definition.mode === 'rows' ? recordNarrative(result, summary, query) : '';
        // The table is ready before the insight is written: show it now.
        run.state({
          preview: {
            title: catalog.objects.find((object: { id: string }) => object.id === current.definition.base)?.name || 'Results',
            mode: current.definition.mode,
            totalCount: summary ? Number(summary.population) || result.rows.length : result.rows.length,
            rows: result.rows.slice(0, 8),
          },
        });
        const matched = current.definition.mode === 'rows' ? Number(summary?.population ?? result.rows.length) : summary?.matchedRecords;
        if (matched === 0) {
          narrativeText = 'No records match the requested filters.';
        } else if (summary?.matchedRecords && summary.numeric.length && summary.numeric.every((n:{statistics:{present:unknown}})=>Number(n.statistics.present)===0)) {
          narrativeText=`${summary.matchedRecords.toLocaleString()} matching records were found, but the requested amount values are missing. A total cannot be calculated from those values.`;
        } else if(current.definition.mode==='rows'&&summary&&!summary.numeric.length&&(result.hasMore||result.rows.length>5)){
          narrativeText=countLine;
        } else if (current.definition.mode === 'aggregate') {
          narrativeText = aggregateNarrative(result.rows, current.definition.mode, query)
            || 'The verified database summary is shown below.';
        } else {
          run.progress('Writing the insight');
          // The count line goes first so the insight only ever adds to it.
          if (countLine) run.text(countLine);
          const records = result.rows.length && result.rows.length <= 5 && !result.hasMore ? result.rows : undefined;
          let insight = '';
          try {
            if (summary) insight = await writeAnalyticalInsight({ question: input.message, summary, records, currency: undefined, signal, onText: (text: string) => run.text(countLine ? `${countLine} ${text}` : text) });
          } catch (error) {
            console.error('[workspace insight] unavailable:', error instanceof Error ? error.message : error);
          }
          if (!insight && agentResult.grounded && structured?.narrative && structured.intent !== 'ask_clarification') insight = structured.narrative;
          narrativeText = [countLine, insight].filter(Boolean).join(' ') || 'The verified database results are shown in the table below.';
        }
        if (!summary) narrativeText += ' Full-dataset summary statistics are unavailable; the displayed results are a preview and must not be treated as full-dataset statistics.';
        run.text(narrativeText);
        const answer = {
          title: structured?.intent === 'answer' && structured.title
            ? structured.title
            : `${catalog.objects.find((object: { id: string }) => object.id === current.definition.base)?.name || 'Database'} ${current.definition.mode === 'aggregate' ? 'Summary' : 'Report'}`,
          narrative: narrativeText,
          ...result,
          summary,
          sourceId: input.sourceId,
          toolName: current.definition.name,
          // Shown under the answer so a Manager knows the figures cover their departments only.
          dataScope: guard.access.allData ? null : `Showing data for: ${guard.access.departmentNames.join(', ') || 'no department'}`,
          databaseName: source.config.database,
          sourceTable: current.definition.base,
          toolId: current.id,
          query,
          page: 1,
          mode: current.definition.mode,
          totalCount: summary ? Number(summary.population) || result.rows.length : undefined,
        };
        run.finish(await saveAnswer(answer));
        void audit(user.id, 'question', input.message.slice(0, 255), { workspaceId: id, sourceId: input.sourceId, tool: current.definition.name, rows: answer.totalCount ?? result.rows.length, scope: answer.dataScope });
      } catch (error) {
        if (accessDeniedMessage || error instanceof AccessDenied) {
          const message = accessDeniedMessage || (error as Error).message;
          void audit(user.id, 'question.denied', input.message.slice(0, 255), { workspaceId: id, reason: message });
          run.error(message, 'access_denied');
          return;
        }
        console.error('[workspace chat] query failed:', error instanceof Error ? error.message : error);
        devLog('failed', error instanceof Error ? error.stack || error.message : String(error));
        run.error(
          signal.aborted ? 'The request took too long. Please try again.' : error instanceof Error&&/^(Use the requested|The requested|Verified request|Query exceeds|Join |Relationships |Multiple relationship|No approved relationship)/.test(error.message)?error.message:lastFailureReason?`I could not build a valid query for this with the approved tools. ${lastFailureReason} Try rephrasing with the table or column you mean.`:'Could not safely complete this query. Check tool approval, schema and connection. No empty result has been inferred.',
          errorCode(error, signal),
        );
      } finally {
        out.close();
      }
    }),
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
