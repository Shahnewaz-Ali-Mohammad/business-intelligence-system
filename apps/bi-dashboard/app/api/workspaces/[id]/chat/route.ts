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
      .map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
  }
  const setup = await listSetup(id);
  if (!setup.sources.some((s) => s.id === input.sourceId))
    return NextResponse.json(
      { error: "Database is not part of this workspace." },
      { status: 403 },
    );
  const tools = setup.tools.filter(
    (t) =>
      t.sourceId === input.sourceId &&
      t.status === "approved",
  );
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
        if (!tools.length) {
          run.finish(await saveAnswer({ narrative: 'Approve tools for this database in Settings before asking data questions.', rows: [], hasMore: false }));
          return;
        }
        run.progress("Understanding your question");
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
        const server = createToolServer(tools, async (chosen: { id: string }, args: Record<string, unknown>) => {
          const latest = await approvedNow(chosen.id);
          const parameters = { query: queryFor(latest.definition, args) };
          const summary = await summarizeTool(source.config, latest.definition, catalog, parameters);
          const population = Number(summary.population) || 0;
          const preview = latest.definition.mode === 'aggregate' || population <= 5
            ? await executeTool(source.config, latest.definition, catalog, parameters, 50)
            : null;
          return {
            tool: latest.definition.name,
            mode: latest.definition.mode,
            summary,
            ...(preview ? { rows: preview.rows, rowsAreComplete: !preview.hasMore } : {}),
            note: `All figures are computed by the database over all ${population.toLocaleString()} matching ${latest.definition.mode === 'aggregate' ? 'groups' : 'records'}. The user sees the rows in the table; do not list them.`,
          };
        });
        const client = new Client({ name: 'bi-workspace-chat', version: '1.0.0' });
        const [left, right] = InMemoryTransport.createLinkedPair();
        await server.connect(right);
        await client.connect(left);
        let agentResult;
        try {
          const lcTools = await loadMcpTools('bi-workspace-tools', client);
          agentResult = await runWorkspaceAgent({
            message: input.message,
            history,
            workspaceName: sourceName(setup, input.sourceId) || workspace!.name,
            tools: lcTools,
            onProgress: (text: string) => run.progress(text),
          });
        } finally {
          await client.close().catch(() => {});
          await server.close().catch(() => {});
        }
        const structured = agentResult.structured;
        const narrativeText = structured?.narrative || 'Could not produce a grounded answer for this question.';
        // The table comes from the LAST approved tool the agent called, with
        // its exact arguments -- the same tool paging and export re-run.
        const byMcpName = new Map(tools.map((t) => [mcpToolName(t.sourceId, t.definition.name), t]));
        const lastCall = [...agentResult.toolCalls].reverse().find((call) => byMcpName.has(call.name));
        if (!lastCall || structured?.intent === 'ask_clarification') {
          run.text(narrativeText);
          run.finish(await saveAnswer({ title: structured?.title, narrative: narrativeText, rows: [], hasMore: false }));
          return;
        }
        run.progress("Preparing the report");
        const current = await approvedNow(byMcpName.get(lastCall.name)!.id);
        const query = queryFor(current.definition, lastCall.args as Record<string, unknown>);
        // The chat shows at most 200 rows; the saved report pages through
        // every row and Export Excel downloads all of them.
        const result = await executeTool(source.config, current.definition, catalog, { query }, 200, 0, { maxLimit: 200 });
        let summary;
        try { summary = await summarizeTool(source.config, current.definition, catalog, { query }); } catch { summary = undefined; }
        run.text(narrativeText);
        const answer = {
          title: structured?.title || current.definition.name,
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
      } catch {
        run.error(
          "Could not safely complete this query. Check tool approval, schema and connection. No empty result has been inferred.",
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
