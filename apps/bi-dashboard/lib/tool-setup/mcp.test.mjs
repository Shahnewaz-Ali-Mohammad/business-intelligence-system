import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createToolServer, mcpToolName } from "./mcp.mjs";

const tool = {
  id: "tool-1",
  sourceId: "database-1",
  status: "approved",
  definition: {
    name: "list_tickets",
    description: "Read matching tickets with a bounded preview.",
    filters: [
      {
        field: "dbo.Tickets:Id",
        operator: "eq",
        parameter: "id",
        required: true,
      },
      {
        field: "dbo.Tickets:LinkId",
        operator: "not_null",
        parameter: "link_id",
        required: true,
      },
    ],
  },
};
async function connect(tools, execute) {
  const server = createToolServer(tools, execute);
  const client = new Client({ name: "unit-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
test("MCP publishes approved tools only and does not require input for NULL predicates", async () => {
  const { client, close } = await connect(
    [tool, { ...tool, id: "draft", status: "draft" }],
    async () => ({}),
  );
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.deepEqual(list.tools[0].inputSchema.required, ["id"]);
    assert.equal(list.tools[0].inputSchema.properties.link_id, undefined);
    assert.equal(list.tools[0].annotations.readOnlyHint, true);
  } finally {
    await close();
  }
});
test("MCP executes the selected database tool with its arguments", async () => {
  const { client, close } = await connect([tool], async (selected, args) => {
    assert.equal(selected.sourceId, "database-1");
    assert.deepEqual(args, { id: 17 });
    return { rows: [{ Id: 17 }], hasMore: false };
  });
  try {
    const result = await client.callTool({
      name: mcpToolName(tool.sourceId, tool.definition.name),
      arguments: { id: 17 },
    });
    assert.deepEqual(JSON.parse(result.content[0].text).rows, [{ Id: 17 }]);
  } finally {
    await close();
  }
});
test("MCP execution failures do not disclose SQL or passwords", async () => {
  const { client, close } = await connect([tool], async () => {
    throw new Error("password=secret SELECT private_data");
  });
  try {
    const result = await client.callTool({
      name: mcpToolName(tool.sourceId, tool.definition.name),
      arguments: { id: 17 },
    });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes("password=secret"));
  } finally {
    await close();
  }
});
test("MCP names stay distinct across databases and long tool names", () => {
  const name = "a".repeat(64);
  assert.ok(mcpToolName("source-1", name).length <= 64);
  assert.notEqual(mcpToolName("source-1", name), mcpToolName("source-2", name));
  assert.notEqual(
    mcpToolName("source-1", name),
    mcpToolName("source-1", `${name.slice(0, 63)}b`),
  );
});
test("stateless HTTP MCP returns a usable JSON list before closing transport", async () => {
  const server = createToolServer([tool], async () => ({}));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    await server.close();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.tools.length, 1);
  } finally {
    await server.close();
  }
});
