import { enterAccess } from '@/lib/access/data-scope.mjs';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import {namedKeyLinks} from '@/lib/tool-setup/named-key-links.mjs';
import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getCurrentUser } from "@/lib/auth/session";
import { getWorkspace } from "@/lib/workspaces/workspaceDb";
import { listSetup, getTool, getSource } from "@/lib/tool-setup/store";
import { discoverDatabase, executeTool } from "@/lib/tool-setup/connectors.mjs";
import { createToolServer } from "@/lib/tool-setup/mcp.mjs";
import type { ToolDefinition } from "@/lib/tool-setup/store";
import { isSameOriginRequest } from "@/lib/tool-setup/request-origin.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSameOriginRequest(request))
    return NextResponse.json(
      { error: "Cross-origin request blocked." },
      { status: 403 },
    );
  const { id } = await params;
  const guard = await requireAccess('setup.manage'); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;
  const workspace = user && (await getWorkspace(id));
  if (
    !user ||
    !workspace ||
    !canOpenWorkspace(guard.access) ||
    id === "isp-default"
  )
    return NextResponse.json(
      { error: "Sign in with the workspace owner account." },
      { status: 403 },
    );
  const setup = await listSetup(id);
  const toolCatalog={relationships:setup.sources.flatMap(source=>namedKeyLinks(source.catalog).relationships)};
  const server = createToolServer(
    setup.tools,
    async (
      selected: { id: string; definition: ToolDefinition },
      arguments_: Record<string, unknown>,
    ) => {
      // Re-read approval before every call; do not execute a revoked or changed definition.
      const tool = await getTool(id, selected.id);
      if (tool.status !== "approved") throw new Error("Tool approval changed.");
      const source = await getSource(id, tool.source_id);
      const catalog = await discoverDatabase(source.config);
      if (catalog.fingerprint !== tool.catalog_fingerprint)
        throw new Error("Schema changed.");
      return executeTool(source.config, tool.definition, catalog, arguments_);
    },
    toolCatalog,
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
