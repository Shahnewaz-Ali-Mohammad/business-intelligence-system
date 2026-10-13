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
        properties: Object.fromEntries(
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
        ),
        ...(t.definition.capabilities
          ? {
              properties: {
                query: {
                  type: "string",
                  maxLength: 20000,
                  description: `JSON query plan. Optional keys: columns (field IDs or "*" for approved fields), where (nested {and:[...]}, {or:[...]}, {not:...}, leaves {field,operator,value} or {field,operator,parameter}), sort [{field,direction:"asc"|"desc"}], dateGroups [{field,grain:"day"|"week"|"month"|"year"}] for grouped dates, distinct (unique projected rows), joins (relationship IDs), groupBy (field IDs), metrics [{field,operation,alias}], filters [{field,operator,parameter,required}], values {parameter:value}. Allowed fields: ${JSON.stringify(t.definition.capabilities.fields)}. Allowed joins: ${JSON.stringify(t.definition.capabilities.joins)}. Omit query for default preview/count. Operators: eq,ne,gt,gte,lt,lte,contains,in,between,is_null,not_null; in/between bind arrays. Metrics: count,count_distinct,sum,avg,min,max. Omit joins to infer an unambiguous approved path; otherwise provide connected join IDs, in either direction. Relationships with kind inferred_named_primary_key are named-key inferences, not declared foreign keys; do not claim their business meaning is confirmed. Fan-out sums require a safe measure grain; independent child totals need separate calls. Relationships: ${JSON.stringify(catalog?.relationships?.filter(j=>t.definition.capabilities.joins.includes(j.id))||[])}. No SQL. Mode: ${t.definition.mode}.`,
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
      const result = await execute(selected, call.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      // Log the real cause on the server and give the agent the reason, so
      // it can correct its arguments instead of giving up.
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[workspace tool] ${call.params.name} failed:`, raw);
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
