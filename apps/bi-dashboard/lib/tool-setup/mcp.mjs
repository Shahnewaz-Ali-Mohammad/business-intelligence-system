import { devLog } from '../dev-log.mjs';
import {queryInputSchema, normalizeMcpArguments} from './mcp-query.mjs';
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export function mcpToolName(sourceId, name) {
  const suffix = crypto
    .createHash("sha256")
    .update(`${sourceId}:${name}`)
    .digest("hex")
    .slice(0, 16);
  return `${name.slice(0, 43)}_db_${suffix}`;
}
// Keeps what the planner reads small: wide tables can otherwise produce
// tool results larger than the model's context window.
function compactResult(result) {
  let text = JSON.stringify(result);
  if (text.length <= 12000 || !result || typeof result !== "object") return text;
  const slim = { ...result };
  if (Array.isArray(slim.rows)) slim.rows = slim.rows.slice(0, 3);
  if (slim.summary?.numeric?.length > 12) slim.summary = { ...slim.summary, numeric: slim.summary.numeric.slice(0, 12), note: "Statistics shown for the first 12 numeric fields." };
  text = JSON.stringify(slim);
  return text.length <= 12000 ? text : text.slice(0, 12000) + '..."(truncated)"';
}
/** @param {any[]} tools @param {Function} execute @param {{relationships?: any[]}|null} [catalog] */
export function createToolServer(tools, execute, catalog = null) {
  const names = new Map(
    tools
      .filter((t) => t.status === "approved")
      .map((t) => [mcpToolName(t.sourceId, t.definition.name), t]),
  );
  const server = new Server(
    { name: "bi-workspace-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...names].map(([name, t]) => ({
      name,
      description: t.definition.description,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { ...Object.fromEntries(
          t.definition.filters
            .filter((f) => !["is_null", "not_null"].includes(f.operator))
            .map((f) => [
              f.parameter,
              {
                type: f.operator==='in'||f.operator==='between'?"array":["string", "number", "boolean"],
                ...(['in','between'].includes(f.operator)?{items:{type:["string","number","boolean"]},minItems:1,maxItems:100}:{}),
                description: `${f.operator} filter on ${f.field}`,
              },
            ]),
        ), ...(t.definition.template ? {
          ...(t.definition.template.limit?{report_limit:{type:'integer',minimum:1,maximum:100000,description:'Maximum rows or groups across all pages.'}}:{}),
          ...(t.definition.template.projection&&t.definition.mode==='rows'?{report_columns:{type:'array',items:{type:'string',enum:t.definition.columns},minItems:1,maxItems:1000,description:'Optional subset of this saved report output. Omit for all fields.'}}:{}),
          ...(t.definition.template.sortFields.length?{report_sort_field:{type:'string',enum:t.definition.template.sortFields},report_sort_direction:{type:'string',enum:['asc','desc']}}:{})
        }: {}) },
        ...(t.definition.capabilities
          ? {
              // Options placed beside query are accepted and folded in server-side.
              additionalProperties: true,
              properties: {
                query: {
                  ...queryInputSchema(t.definition),
                  description: `${queryInputSchema(t.definition).description} Base table: ${t.definition.base}. Mode: ${t.definition.mode}. Use allColumns:true for all approved details. columns must be an array of exact field IDs, not a comma-separated string. Example projection: ${JSON.stringify({query:{columns:t.definition.capabilities.fields.filter(f=>f.startsWith(t.definition.base+':')).slice(0,2),limit:100}})}. Omit joins to infer a unique approved path; otherwise specify approved relationship IDs. Never sum repeated parent measures across a one-to-many join. Relationships: ${JSON.stringify(catalog?.relationships?.filter(j=>t.definition.capabilities.joins.includes(j.id))||[])}. No SQL.`,
                },
              },
            }
          : {}),
        required: t.definition.filters
          .filter(
            (f) => f.required && !["is_null", "not_null"].includes(f.operator),
          )
          .map((f) => f.parameter),
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const selected = names.get(call.params.name);
      if (!selected) throw new Error("Unavailable tool.");
      const result = await execute(selected, normalizeMcpArguments(selected.definition, call.params.arguments || {}));
      return { content: [{ type: "text", text: compactResult(result) }] };
    } catch (error) {
      // Log the real cause on the server and give the agent the reason, so
      // it can correct its arguments instead of giving up.
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[workspace tool] ${call.params.name} failed:`, raw);
      devLog("mcp-error", {tool: call.params.name, args: call.params.arguments, error: raw});
      // Only plan/argument validation messages go back to the agent; database
      // errors may contain SQL, credentials or data and are never returned.
      const unsafe = (error && typeof error === "object" && "code" in error) ||
        /password|passwd|secret|token|\bselect\b|\bfrom\b|\bwhere\b|sql|\bconnection\b|ECONN|login/i.test(raw);
      const reason = unsafe ? "the database could not run this query (details are in the server log)" : raw;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${reason.slice(0, 500)}. Check the arguments against this tool's parameters and try again.`,
          },
        ],
      };
    }
  });
  return server;
}
