import crypto from "node:crypto";
import { getAppDb } from "@/lib/db/app-db";
import {
  encryptConnectionString,
  decryptConnectionString,
} from "@/lib/workspaces/secrets";
import { fingerprint } from "./model.mjs";

export type SourceConfig = {
  dialect: "postgres" | "mysql" | "sqlserver";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  tls: boolean;
  trustServerCertificate: boolean;
};
export type Column = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  restricted?: boolean;
};
export type Catalog = {
  objects: {
    id: string;
    schema: string;
    name: string;
    kind: string;
    columns: Column[];
    parameters?: unknown;
    executionBlocked?: boolean;
  }[];
  relationships: {
    id: string;
    from: string;
    to: string;
    targetUnique: boolean;
    columns: { from: string; to: string }[];
  }[];
  fingerprint: string;
};
export type ToolDefinition = {
  capabilities?: { fields: string[]; joins: string[] };
  name: string;
  description: string;
  base: string;
  joins: string[];
  mode: "rows" | "aggregate";
  columns: string[];
  groupBy: string[];
  metrics: {
    field: string | null;
    operation: "count" | "sum" | "avg" | "min" | "max";
    alias: string;
  }[];
  filters: {
    field: string;
    operator:
      | "eq"
      | "ne"
      | "gt"
      | "gte"
      | "lt"
      | "lte"
      | "contains"
      | "is_null"
      | "not_null";
    parameter: string;
    required: boolean;
  }[];
};
type ServerRow = { id: string; name: string; encrypted_config: string };
type SourceRow = {
  id: string;
  server_id: string;
  database_name: string;
  catalog_json: string;
  catalog_fingerprint: string;
  encrypted_config: string;
};
export type ToolRow = {
  id: string;
  source_id: string;
  name: string;
  definition_json: string;
  catalog_fingerprint: string;
  status: string;
  version: number;
  tested_hash: string | null;
};

export async function listSetup(workspaceId: string) {
  const db = getAppDb();
  const [servers] = await db.execute(
    "SELECT id,name,encrypted_config FROM bi_tool_servers WHERE workspace_id=? ORDER BY created_at",
    [workspaceId],
  );
  const safeServers = (servers as ServerRow[]).map((s) => {
    const config: SourceConfig = JSON.parse(
      decryptConnectionString(s.encrypted_config),
    );
    return {
      id: s.id,
      name: s.name,
      dialect: config.dialect,
      host: config.host,
      port: config.port,
      tls: config.tls,
    };
  });
  const [sources] = await db.execute(
    "SELECT s.id,s.server_id,s.database_name,s.catalog_json FROM bi_tool_sources s JOIN bi_tool_servers v ON v.id=s.server_id WHERE v.workspace_id=? ORDER BY s.database_name",
    [workspaceId],
  );
  const [tools] = await db.execute(
    "SELECT t.* FROM bi_generated_tools t JOIN bi_tool_sources s ON s.id=t.source_id JOIN bi_tool_servers v ON v.id=s.server_id WHERE v.workspace_id=? ORDER BY t.name",
    [workspaceId],
  );
  return {
    servers: safeServers,
    sources: (sources as SourceRow[]).map((s) => ({
      id: s.id,
      serverId: s.server_id,
      database: s.database_name,
      catalog: JSON.parse(s.catalog_json) as Catalog,
    })),
    tools: (tools as ToolRow[]).map((t) => ({
      id: t.id,
      sourceId: t.source_id,
      definition: JSON.parse(t.definition_json) as ToolDefinition,
      status: t.status,
      version: t.version,
    })),
  };
}
export async function saveServer(
  workspaceId: string,
  name: string,
  config: SourceConfig,
) {
  const id = crypto.randomUUID();
  await getAppDb().execute(
    "INSERT INTO bi_tool_servers(id,workspace_id,name,encrypted_config) VALUES(?,?,?,?)",
    [id, workspaceId, name, encryptConnectionString(JSON.stringify(config))],
  );
  return id;
}
export async function getServer(workspaceId: string, serverId: string) {
  const [rows] = await getAppDb().execute(
    "SELECT id,name,encrypted_config FROM bi_tool_servers WHERE id=? AND workspace_id=?",
    [serverId, workspaceId],
  );
  const row = (rows as ServerRow[])[0];
  if (!row) throw new Error("Server not found.");
  return JSON.parse(
    decryptConnectionString(row.encrypted_config),
  ) as SourceConfig;
}
export async function saveSource(
  serverId: string,
  database: string,
  catalog: Catalog,
) {
  const connection = await getAppDb().getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute(
      "SELECT id FROM bi_tool_sources WHERE server_id=? AND database_name=? FOR UPDATE",
      [serverId, database],
    );
    const id = (existing as { id: string }[])[0]?.id || crypto.randomUUID();
    await connection.execute(
      "INSERT INTO bi_tool_sources(id,server_id,database_name,catalog_json,catalog_fingerprint) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE catalog_json=VALUES(catalog_json),catalog_fingerprint=VALUES(catalog_fingerprint),discovered_at=NOW()",
      [id, serverId, database, JSON.stringify(catalog), catalog.fingerprint],
    );
    await connection.execute(
      "UPDATE bi_generated_tools SET status='draft',tested_hash=NULL,tested_at=NULL,approved_at=NULL WHERE source_id=? AND catalog_fingerprint<>?",
      [id, catalog.fingerprint],
    );
    await connection.commit();
    return id;
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}
export async function getSource(workspaceId: string, sourceId: string) {
  const [rows] = await getAppDb().execute(
    "SELECT s.*,v.encrypted_config FROM bi_tool_sources s JOIN bi_tool_servers v ON v.id=s.server_id WHERE s.id=? AND v.workspace_id=?",
    [sourceId, workspaceId],
  );
  const row = (rows as SourceRow[])[0];
  if (!row) throw new Error("Database not found.");
  const config: SourceConfig = JSON.parse(
    decryptConnectionString(row.encrypted_config),
  );
  return {
    config: { ...config, database: row.database_name },
    catalog: JSON.parse(row.catalog_json) as Catalog,
  };
}
export async function saveDrafts(sourceId: string, catalogFingerprint: string, definitions: ToolDefinition[]) {
  const {saveDraftDefinitions} = await import('./draft-storage.mjs');
  const connection = await getAppDb().getConnection();
  try { return await saveDraftDefinitions(connection, sourceId, catalogFingerprint, definitions) as { added: number; updated: number; unchanged: number; removed: number }; }
  finally { connection.release(); }
}
export async function getTool(workspaceId: string, toolId: string) {
  const [rows] = await getAppDb().execute(
    "SELECT t.* FROM bi_generated_tools t JOIN bi_tool_sources s ON s.id=t.source_id JOIN bi_tool_servers v ON v.id=s.server_id WHERE t.id=? AND v.workspace_id=?",
    [toolId, workspaceId],
  );
  const row = (rows as ToolRow[])[0];
  if (!row) throw new Error("Tool not found.");
  return {
    ...row,
    definition: JSON.parse(row.definition_json) as ToolDefinition,
  };
}
export async function markTested(tool: Awaited<ReturnType<typeof getTool>>) {
  const [result] = await getAppDb().execute(
    "UPDATE bi_generated_tools t JOIN bi_tool_sources s ON s.id=t.source_id SET t.status=IF(t.status='approved','approved','tested'),t.tested_hash=?,t.tested_at=NOW() WHERE t.id=? AND t.version=? AND t.definition_json=? AND s.catalog_fingerprint=t.catalog_fingerprint",
    [fingerprint(tool.definition), tool.id, tool.version, tool.definition_json],
  );
  if (!(result as { affectedRows: number }).affectedRows)
    throw new Error(
      "Tool changed during testing. Reload and test the new version.",
    );
}
export async function recordTest(
  tool: Awaited<ReturnType<typeof getTool>>,
  succeeded: boolean,
  preview?: { rows: unknown[]; hasMore: boolean; elapsedMs: number },
) {
  await getAppDb().execute(
    "INSERT INTO bi_tool_test_runs(id,tool_id,version,definition_hash,catalog_fingerprint,succeeded,preview_count,has_more,elapsed_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      crypto.randomUUID(),
      tool.id,
      tool.version,
      fingerprint(tool.definition),
      tool.catalog_fingerprint,
      succeeded,
      preview?.rows.length || 0,
      preview?.hasMore || false,
      preview?.elapsedMs || 0,
    ],
  );
}
export async function changeToolApprovals(
  tools: Awaited<ReturnType<typeof getTool>>[],
  approved: boolean,
) {
  const { updateApprovals } = await import('./approval.mjs');
  const db = await getAppDb().getConnection();
  try {
    return await updateApprovals(db, tools, approved);
  } finally {
    db.release();
  }
}
