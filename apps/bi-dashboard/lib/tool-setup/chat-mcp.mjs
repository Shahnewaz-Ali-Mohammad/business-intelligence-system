import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolServer, mcpToolName } from './mcp.mjs';

export async function callWorkspaceMcp(tools, selected, arguments_, execute, signal) {
  const server = createToolServer(tools, execute);
  const client = new Client({ name: 'bi-workspace-chat', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const listing = await client.listTools({}, { signal });
    const name = mcpToolName(selected.sourceId, selected.definition.name);
    if (!listing.tools.some((t) => t.name === name)) throw new Error('Tool is not approved for this chat.');
    const response = await client.callTool({ name, arguments: selected.definition.capabilities ? arguments_ : JSON.parse(arguments_.query).values || {} }, undefined, { signal });
    if (response.isError) throw new Error('MCP tool execution failed.');
    const text = response.content.find((c) => c.type === 'text');
    if (!text) throw new Error('MCP tool returned no structured result.');
    return JSON.parse(text.text);
  } finally {
    await client.close();
    await server.close();
  }
}
