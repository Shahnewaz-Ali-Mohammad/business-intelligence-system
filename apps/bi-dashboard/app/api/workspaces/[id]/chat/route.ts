import {validateExecutionRequest} from '@/lib/tool-setup/execution-request.mjs';
import {candidateTools} from '@/lib/tool-setup/chat-planning.mjs';
import { ChatOpenAI } from '@langchain/openai';
import { workspaceEntry } from '../../../../../scripts/chat/workspace-entry.mjs';
import { writeAnalyticalInsight } from '../../../../../scripts/lib/analytical-insight.mjs';
import {validateReportSelection} from '@/lib/tool-setup/request-fields.mjs';
import {resolveSavedRequest,missingReportDecision} from '@/lib/tool-setup/lookup-resolution.mjs';
import {addRequestedCalculations} from '@/lib/tool-setup/analysis-intent.mjs';
import {devLog} from '@/lib/dev-log.mjs';
import {compileTool} from '@/lib/tool-setup/model.mjs';
import {savedReportTools} from '@/lib/tool-setup/saved-report-tools.mjs';
import {recordNarrative,requestedRecordArguments,validateRecordPopulation} from '@/lib/tool-setup/record-presentation.mjs';
import {reportContext} from '@/lib/tool-setup/report-context.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createToolServer, mcpToolName } from '@/lib/tool-setup/mcp.mjs';
import { runWorkspaceAgent } from '../../../../../scripts/chat/agent.mjs';
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
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
// Used only when the insight writer is unavailable: describes the largest
// groups directly from the database result instead of a placeholder.
function groupedFallback(rows: Record<string, unknown>[], mode: string) {
  if (mode !== 'aggregate' || !rows.length) return '';
  const keys = Object.keys(rows[0]);
  const numericKey = (k: string) => !k.includes(':') && rows.every((r) => r[k] == null || Number.isFinite(Number(r[k])));
  const metric = keys.find(numericKey) || keys.at(-1)!;
  const labels = keys.filter((k) => k.includes(':'));
  const total = rows.reduce((n, r) => n + (Number(r[metric]) || 0), 0);
  const top = [...rows].sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0)).slice(0, 3);
  const text = (v: unknown) => v == null ? 'Missing' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/T00:00:00(?:\.000)?Z$/, '');
  const name = (r: Record<string, unknown>) => labels.map((k) => text(r[k])).join(' / ') || 'All';
  const share = (r: Record<string, unknown>) => (total ? ` (${(((Number(r[metric]) || 0) / total) * 100).toFixed(1)}%)` : '');
  return `${rows.length.toLocaleString()} groups. Largest: ${top.map((r) => `${name(r)} ${Number(r[metric]).toLocaleString()}${share(r)}`).join(', ')}.`;
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
  const user = await getCurrentUser();
  const workspace = user && (await getWorkspace(id));
  if (
    !user ||
    !workspace ||
    workspace.ownerUserId !== user.id ||
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
  const tools = candidateTools(input.message, approvedTools);
  let lastFailureReason = '';
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(150000)]);
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
      const savedAnswer = { ...answer, sourceId: input.sourceId, sessionId };
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
  const stream = new ReadableStream({
    async start(out) {
      const run = createRunEvents(
        (event: unknown) => out.enqueue(encoder.encode(eventFrame(event))),
        {
          threadId: id,
          runId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
        },
      );
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
        // What the AI reads: database-computed statistics over the FULL
        // result, never row dumps (rows only for tiny results; aggregate
        // groups are themselves database summaries).
        const completedExecutions: {toolId: string; query: string}[] = [];
        let executionFailed=false;
        let executionFailureReason='';
        const server = createToolServer(tools, async (chosen: { id: string }, args: Record<string, unknown>) => {
          try {
          let latest = await approvedNow(chosen.id);
          if (!latest.definition.capabilities) validateReportSelection(input.message,latest.definition,tools);
          let parameters = { query: addRequestedCalculations(input.message,latest.definition,queryFor(latest.definition, requestedRecordArguments(input.message,latest.definition,args)),catalog) };
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
            const keepWhere = !plan.where || JSON.stringify(plan.where).match(/"field":"([^"]+)"/g)?.every((m: string) => own(m.slice(9, -1)));
            latest = await approvedNow(target.id);
            parameters = { query: addRequestedCalculations(input.message, latest.definition, JSON.stringify(latest.definition.mode === 'rows' ? { columns: '*', ...(keepWhere && plan.where ? { where: plan.where } : {}) } : { ...plan }), catalog) };
            devLog('rerouted', { reason: 'named table', to: target.definition.name });
          }
          validateExecutionRequest(input.message,latest.definition,catalog,source.config.dialect,parameters);
          devLog('tool-call', {tool: latest.definition.name, parameters});
          // Statistics are best-effort: if they cannot be computed, the agent
          // still gets a small preview instead of a failed call.
          let summary: Awaited<ReturnType<typeof summarizeTool>> | null = null;
          try { summary = await summarizeTool(source.config, latest.definition, catalog, parameters); }
          catch (error) { console.error('[workspace tool] statistics failed:', error instanceof Error ? error.message : error); }
          const population = summary ? Number(summary.population) || 0 : 0;
          const preview = !summary || latest.definition.mode === 'aggregate' || population <= 5
            ? await executeTool(source.config, latest.definition, catalog, parameters, 50)
            : null;
          completedExecutions.push({toolId: latest.id, query: parameters.query});
          return {
            tool: latest.definition.name,
            mode: latest.definition.mode,
            summary,
            ...(preview ? { rows: preview.rows, rowsAreComplete: !preview.hasMore } : {}),
            note: summary
              ? `Grain: ${summary.scope}. Available figures are computed by the database over ${population.toLocaleString()} matching ${latest.definition.mode === 'aggregate' ? 'groups' : 'records'}. The user sees the rows in the table; do not list them.`
              : 'Full-population statistics are unavailable. Only a bounded preview is available; do not infer a total, average, median, extrema, or absence of records for the full dataset from this preview. The user sees the rows in the table; do not list them.',
          };
          } catch (error) {
            devLog('tool-error', {args, error: error instanceof Error ? error.message : String(error)});
            executionFailed = true;
            const reason = error instanceof Error ? error.message : '';
            if (/^(Use the requested|The requested|Query exceeds|Join |Relationships |Multiple relationship|No approved relationship|This request|Choose the stored)/.test(reason)) { executionFailureReason = reason; lastFailureReason = reason; }
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
            const approvedFields=new Set(tools.flatMap(t=>t.definition.capabilities?.fields||[]));
            const valueFields=catalog.objects.flatMap((o:{id:string;columns:{name:string;dataType:string}[]})=>o.columns.filter(c=>/char|text/i.test(c.dataType)&&approvedFields.has(o.id+':'+c.name)).map(c=>o.id+':'+c.name));
            const findValues=async(field:string,search?:string)=>{
              const candidates=tools.filter(t=>t.definition.mode==='aggregate'&&t.definition.capabilities?.fields.includes(field));
              const chosen=candidates.find(t=>field.startsWith(t.definition.base+':'))||candidates[0];
              if(!chosen)throw new Error('No approved capability supports this reference field.');
              const latest=await approvedNow(chosen.id);
              const query=JSON.stringify({groupBy:[field],metrics:[{field:null,operation:'count',alias:'occurrences'}],...(search?{where:{field,operator:'contains',value:search}}:{}),limit:50});
              const result=await executeTool(source.config,latest.definition,catalog,{query},50);
              return {field,values:result.rows,hasMore:result.hasMore,note:'Use exact stored labels. This lookup does not fulfill the employee report request.'};
            };
            const lcTools = tools.some(t=>t.definition.template) ? [...savedReportTools(client,tools,{findValues,valueFields}),...exposed.filter(t=>reusableNames.has(t.name))] : exposed;
            agentResult = await runWorkspaceAgent({message:input.message,history,workspaceName:sourceName(setup,input.sourceId)||workspace!.name,tools:lcTools,signal,onProgress:(text:string)=>run.progress(text)});
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
        const result = await executeTool(source.config, current.definition, catalog, { query }, 200, 0, { maxLimit: 200 });
        let summary;
        try { summary = await summarizeTool(source.config, current.definition, catalog, { query }); } catch { summary = undefined; }
        // Same insight step as the original chat: the answer is written from
        // database statistics over the FULL result (writeAnalyticalInsight),
        // never replaced by a fixed placeholder sentence.
        const countLine = current.definition.mode === 'rows' ? recordNarrative(result, summary, query) : '';
        const matched = current.definition.mode === 'rows' ? Number(summary?.population ?? result.rows.length) : summary?.matchedRecords;
        if (matched === 0) {
          narrativeText = 'No records match the requested filters.';
        } else if (summary?.matchedRecords && summary.numeric.length && summary.numeric.every((n:{statistics:{present:unknown}})=>Number(n.statistics.present)===0)) {
          narrativeText=`${summary.matchedRecords.toLocaleString()} matching records were found, but the requested amount values are missing. A total cannot be calculated from those values.`;
        } else {
          run.progress('Preparing insights');
          const records = result.rows.length && result.rows.length <= 5 && !result.hasMore ? result.rows : undefined;
          let insight = '';
          try {
            if (summary) insight = await writeAnalyticalInsight({ question: input.message, summary, records, currency: undefined, signal, onText: (text: string) => run.text(countLine ? `${countLine} ${text}` : text) });
          } catch (error) {
            console.error('[workspace insight] unavailable:', error instanceof Error ? error.message : error);
          }
          if (!insight && agentResult.grounded && structured?.narrative && structured.intent !== 'ask_clarification') insight = structured.narrative;
          if (!insight) insight = groupedFallback(result.rows, current.definition.mode);
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
          toolId: current.id,
          query,
          page: 1,
          mode: current.definition.mode,
          totalCount: summary ? Number(summary.population) || result.rows.length : undefined,
        };
        run.finish(await saveAnswer(answer));
      } catch (error) {
        console.error('[workspace chat] query failed:', error instanceof Error ? error.message : error);
        devLog('failed', error instanceof Error ? error.stack || error.message : String(error));
        run.error(
          error instanceof Error&&/^(Use the requested|The requested|Query exceeds|Join |Relationships |Multiple relationship|No approved relationship)/.test(error.message)?error.message:lastFailureReason?`I could not build a valid query for this with the approved tools. ${lastFailureReason} Try rephrasing with the table or column you mean.`:'Could not safely complete this query. Check tool approval, schema and connection. No empty result has been inferred.',
        );
      } finally {
        out.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
