// CRUD for workspaces/connections/semantic models, all against the app's
// own database (bi_app, MySQL -- getAppDb()), never the analytical
// warehouse. Mirrors the existing pattern in lib/dashboard/* and the
// chat-sessions routes: plain mysql2 queries, no ORM, since that's what
// the rest of this codebase already uses.
import { getAppDb } from '@/lib/db/app-db';
import { encryptConnectionString, decryptConnectionString } from './secrets';
import crypto from 'node:crypto';

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: number;
  aiSystemPrompt: string | null;
  createdAt: string;
}

export interface WorkspaceConnection {
  workspaceId: string;
  dialect: string;
  host: string;
  port: number;
  databaseName: string;
}

export async function listWorkspaces(userId: number): Promise<Workspace[]> {
  const [rows] = await getAppDb().execute(
    `select id, name, owner_user_id as ownerUserId, ai_system_prompt as aiSystemPrompt, created_at as createdAt
       from workspaces where owner_user_id = ? order by created_at desc`,
    [userId]
  );
  return rows as Workspace[];
}

export async function createWorkspace(name: string, ownerUserId: number): Promise<Workspace> {
  const id = crypto.randomUUID();
  await getAppDb().execute(`insert into workspaces (id, name, owner_user_id) values (?, ?, ?)`, [
    id,
    name,
    ownerUserId,
  ]);
  return { id, name, ownerUserId, aiSystemPrompt: null, createdAt: new Date().toISOString() };
}

export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const [rows] = await getAppDb().execute(
    `select id, name, owner_user_id as ownerUserId, ai_system_prompt as aiSystemPrompt, created_at as createdAt
       from workspaces where id = ?`,
    [workspaceId]
  );
  const list = rows as Workspace[];
  return list[0] ?? null;
}

export async function saveConnection(
  workspaceId: string,
  dialect: string,
  host: string,
  port: number,
  databaseName: string,
  connectionString: string
): Promise<void> {
  const encrypted = encryptConnectionString(connectionString);
  await getAppDb().execute(
    `insert into workspace_connections (workspace_id, dialect, host, port, database_name, encrypted_conn_string)
     values (?, ?, ?, ?, ?, ?)
     on duplicate key update dialect = values(dialect), host = values(host), port = values(port),
       database_name = values(database_name), encrypted_conn_string = values(encrypted_conn_string)`,
    [workspaceId, dialect, host, port, databaseName, encrypted]
  );
}

export async function getConnection(
  workspaceId: string
): Promise<(WorkspaceConnection & { connectionString: string }) | null> {
  const [rows] = await getAppDb().execute(
    `select workspace_id as workspaceId, dialect, host, port, database_name as databaseName, encrypted_conn_string as encryptedConnString
       from workspace_connections where workspace_id = ?`,
    [workspaceId]
  );
  const list = rows as (WorkspaceConnection & { encryptedConnString: string })[];
  const row = list[0];
  if (!row) return null;
  return { ...row, connectionString: decryptConnectionString(row.encryptedConnString) };
}

export async function saveDraftYaml(workspaceId: string, draftYaml: string): Promise<void> {
  await getAppDb().execute(
    `insert into workspace_semantic_models (workspace_id, status, draft_yaml, drafted_at)
     values (?, 'drafted', ?, now())
     on duplicate key update status = 'drafted', draft_yaml = values(draft_yaml), drafted_at = now()`,
    [workspaceId, draftYaml]
  );
}

export async function confirmYaml(workspaceId: string, confirmedYaml: string): Promise<void> {
  await getAppDb().execute(
    `insert into workspace_semantic_models (workspace_id, status, confirmed_yaml, confirmed_at)
     values (?, 'confirmed', ?, now())
     on duplicate key update status = 'confirmed', confirmed_yaml = values(confirmed_yaml), confirmed_at = now()`,
    [workspaceId, confirmedYaml]
  );
}

export async function getSemanticModel(
  workspaceId: string
): Promise<{ status: string; draftYaml: string | null; confirmedYaml: string | null } | null> {
  const [rows] = await getAppDb().execute(
    `select status, draft_yaml as draftYaml, confirmed_yaml as confirmedYaml
       from workspace_semantic_models where workspace_id = ?`,
    [workspaceId]
  );
  const list = rows as { status: string; draftYaml: string | null; confirmedYaml: string | null }[];
  return list[0] ?? null;
}

export async function recordSyncRun(
  workspaceId: string,
  status: 'succeeded' | 'failed',
  rowsSynced: number | null,
  error: string | null
): Promise<void> {
  await getAppDb().execute(
    `insert into workspace_sync_runs (workspace_id, status, finished_at, rows_synced, error)
     values (?, ?, now(), ?, ?)`,
    [workspaceId, status, rowsSynced, error]
  );
}

export async function deleteWorkspace(workspaceId: string, ownerUserId: number): Promise<boolean> {
  // Scoped to owner_user_id in the WHERE clause, not just checked beforehand --
  // makes it impossible for one request to delete a workspace it doesn't own
  // even if a caller forgets to check first. Cascades to workspace_connections,
  // workspace_semantic_models, and workspace_sync_runs via their FK
  // ON DELETE CASCADE (see database/bi_app_schema.sql) -- deleting the
  // workspace row is enough, no need to delete children manually.
  const [result] = await getAppDb().execute(
    `delete from workspaces where id = ? and owner_user_id = ?`,
    [workspaceId, ownerUserId]
  );
  return (result as { affectedRows: number }).affectedRows > 0;
}
