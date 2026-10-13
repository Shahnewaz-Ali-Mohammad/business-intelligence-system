import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getCurrentUser } from "@/lib/auth/session";
import { getWorkspace } from "@/lib/workspaces/workspaceDb";
import { listSetup, getTool, getSource } from "@/lib/tool-setup/store";
import { discoverDatabase, executeTool } from "@/lib/tool-setup/connectors.mjs";
import { createToolServer } from "@/lib/tool-setup/mcp.mjs";
import type { ToolDefinition } from "@/lib/tool-setup/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin)
    return NextResponse.json(
      { error: "Cross-origin request blocked." },
      { status: 403 },
    );
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
      { error: "Sign in with the workspace owner account." },
      { status: 403 },
    );
  const setup = await listSetup(id);
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
