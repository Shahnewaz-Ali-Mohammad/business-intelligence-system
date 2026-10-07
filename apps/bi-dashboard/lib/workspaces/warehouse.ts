import crypto from 'node:crypto';
import { getAppDb } from '@/lib/db/app-db';
import { getConnection, getSemanticModel, getWorkspace } from './workspaceDb';
import { encryptConnectionString } from './secrets';
import { parseModel } from '../../../bi-warehouse/src/semantic/warehouseModel.mjs';
import { connectionConfig, discoverWarehouse } from '../../../bi-warehouse/src/introspection/discoverWarehouse.mjs';

const schemaChecks = new Map<string, { at: number; fingerprint: string }>();

export const connectionFingerprint = (url: string) => {
  if (!process.env.WORKSPACE_SECRETS_KEY) throw new Error('Warehouse secrets key is not configured.');
  return crypto.createHmac('sha256', process.env.WORKSPACE_SECRETS_KEY).update(url).digest('hex');
};

export async function warehouseContext(id: string, userId: number, fingerprint?: string) {
  const workspace = await getWorkspace(id);
  if (!workspace || workspace.ownerUserId !== userId) throw new Error('Warehouse not found.');
  const saved = await getSemanticModel(id);
  const connection = await getConnection(id);
  if (!saved?.confirmedYaml || !connection) throw new Error('Activate this warehouse in Data Sources before chatting.');
  const model = parseModel(saved.confirmedYaml);
  if (model.workspaceId !== id || model.connectionFingerprint !== connectionFingerprint(connection.connectionString)) throw new Error('Warehouse connection changed; review and reactivate it.');
  if (fingerprint && fingerprint !== model.fingerprint) throw new Error('This report uses an older warehouse model. Ask again to generate a report with the current model.');
  connectionConfig(connection.connectionString);
  const cacheKey = `${id}:${model.fingerprint}`;
  let checked = schemaChecks.get(cacheKey);
  if (!checked || Date.now() - checked.at > 60000) {
    const discovery = await discoverWarehouse(connection.connectionString, model.schemas);
    checked = { at: Date.now(), fingerprint: discovery.fingerprint };
    schemaChecks.set(cacheKey, checked);
    if (schemaChecks.size > 100) schemaChecks.delete(schemaChecks.keys().next().value!);
  }
  if (checked.fingerprint !== model.schemaFingerprint) throw new Error('Warehouse schema changed. Discover and validate it again in Data Sources before querying.');
  return { model, ownerUserId: userId, connectionString: connection.connectionString, name: workspace.name };
}
export async function stageWarehousePreview(id: string, expectedDraft: string, previewDraft: string) {
  const digest = crypto.createHash('sha256').update(expectedDraft).digest('hex');
  const [result] = await getAppDb().execute('UPDATE workspace_semantic_models SET draft_yaml=? WHERE workspace_id=? AND SHA2(draft_yaml,256)=?', [previewDraft, id, digest]);
  if ((result as { affectedRows: number }).affectedRows !== 1) throw new Error('Warehouse setup changed during validation.');
}

export async function activateWarehouse(id: string, url: string, yaml: string, expectedDraft: string) {
  const cfg = connectionConfig(url);
  const connection = await getAppDb().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT draft_yaml FROM workspace_semantic_models WHERE workspace_id=? FOR UPDATE', [id]);
    if ((rows as { draft_yaml: string }[])[0]?.draft_yaml !== expectedDraft) throw new Error('Warehouse setup changed during validation.');
    await connection.execute(`INSERT INTO workspace_connections(workspace_id,dialect,host,port,database_name,encrypted_conn_string) VALUES(?,'postgres',?,?,?,?) ON DUPLICATE KEY UPDATE dialect='postgres',host=VALUES(host),port=VALUES(port),database_name=VALUES(database_name),encrypted_conn_string=VALUES(encrypted_conn_string)`, [id, cfg.host, cfg.port, cfg.database, encryptConnectionString(url)]);
    await connection.execute(`INSERT INTO workspace_semantic_models(workspace_id,status,confirmed_yaml,confirmed_at) VALUES(?,'confirmed',?,NOW()) ON DUPLICATE KEY UPDATE status='confirmed',confirmed_yaml=VALUES(confirmed_yaml),confirmed_at=NOW()`, [id, yaml]);
    await connection.commit();
  } catch (e) { await connection.rollback(); throw e; }
  finally { connection.release(); }
}
export function configuredWarehouseUrl() {
  const { WAREHOUSE_PG_HOST: host, WAREHOUSE_PG_DATABASE: database, WAREHOUSE_PG_USER: user, WAREHOUSE_PG_PASSWORD: password, WAREHOUSE_PG_PORT: port } = process.env;
  if (!host || !database || !user) throw new Error('The existing warehouse connection is not configured.');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password || '')}@${host}:${port || 5432}/${encodeURIComponent(database)}`;
}
