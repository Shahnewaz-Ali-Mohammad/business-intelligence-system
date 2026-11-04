import { getAppDb } from '@/lib/db/app-db';
import { SpecSchema, emptySpec, type Message, type Spec } from './spec';

type Row = { id: number; workspace_id: string; title: string; spec_json: string; messages_json: string; created_by: number; updated_at: string; created_at: string; published: number; share_scope: 'private' | 'workspace' | 'selected'; allow_export: number };
export type ShareScope = 'private' | 'workspace' | 'selected';
export type DesignPermissions = { canEdit: boolean; canManageShare: boolean; canExport: boolean };
export type ShareAudience = { users: number[]; roles: string[]; departments: number[] };

export type Design = { id: number; workspaceId: string; title: string; spec: Spec; messages: Message[]; createdBy: number; updatedAt: string; published: boolean; shareScope: ShareScope; allowExport: boolean; audience: ShareAudience };

const parseSpec = (text: string): Spec => { try { return SpecSchema.parse(JSON.parse(text)); } catch { return emptySpec(); } };
const parseMessages = (text: string): Message[] => { try { const m = JSON.parse(text); return Array.isArray(m) ? m : []; } catch { return []; } };
const toDesign = (r: Row, audience: ShareAudience = { users: [], roles: [], departments: [] }): Design => ({ id: r.id, workspaceId: r.workspace_id, title: r.title, spec: parseSpec(r.spec_json), messages: parseMessages(r.messages_json), createdBy: r.created_by, updatedAt: r.updated_at, published: !!r.published, shareScope: r.share_scope || 'private', allowExport: !!r.allow_export, audience });

/** True once the report designer and report-sharing migrations are installed. */
export async function designerReady() {
  try {
    const db = getAppDb();
    await db.query('SELECT published, share_scope, allow_export FROM designed_reports LIMIT 0');
    await db.query('SELECT report_id, audience_type, audience_id FROM designed_report_audiences LIMIT 0');
    await db.query('SELECT 1 FROM designed_report_versions LIMIT 0');
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') return false;
    throw error;
  }
}

export async function listDesigns(workspaceIds: 'all' | string[], userId: number, roles: string[], departmentIds: number[], permissions: string[]) {
  if (workspaceIds !== 'all' && !workspaceIds.length) return [];
  const where = workspaceIds === 'all' ? '' : `WHERE workspace_id IN (${workspaceIds.map(() => '?').join(',')})`;
  const db = getAppDb();
  const [rows] = await db.query(`SELECT id, workspace_id, title, spec_json, created_by, updated_at, created_at, published, share_scope, allow_export FROM designed_reports ${where} ORDER BY updated_at DESC LIMIT 500`, workspaceIds === 'all' ? [] : workspaceIds);
  const items = rows as Row[];
  if (!items.length) return [];
  const ids = items.map((r) => r.id);
  const [shares] = await db.query(`SELECT report_id, audience_type, audience_id FROM designed_report_audiences WHERE report_id IN (${ids.map(() => '?').join(',')})`, ids);
  const audienceByReport = new Map<number, ShareAudience>();
  for (const row of shares as { report_id: number; audience_type: string; audience_id: string }[]) {
    const audience = audienceByReport.get(row.report_id) || { users: [], roles: [], departments: [] };
    if (row.audience_type === 'user') audience.users.push(Number(row.audience_id));
    if (row.audience_type === 'role') audience.roles.push(row.audience_id);
    if (row.audience_type === 'department') audience.departments.push(Number(row.audience_id));
    audienceByReport.set(row.report_id, audience);
  }
  return items.flatMap((r) => {
    const audience = audienceByReport.get(r.id) || { users: [], roles: [], departments: [] };
    const isOwner = Number(r.created_by) === userId;
    const shared = !!r.published && (r.share_scope === 'workspace' || (r.share_scope === 'selected' && (audience.users.includes(userId) || roles.some((role) => audience.roles.includes(role)) || departmentIds.some((id) => audience.departments.includes(id)))));
    if (!isOwner && !shared) return [];
    const spec = parseSpec(r.spec_json);
    const canEdit = isOwner && permissions.includes('reports.save');
    return [{ id: r.id, workspaceId: r.workspace_id, title: r.title, blocks: spec.blocks.length, updatedAt: r.updated_at, createdAt: r.created_at, permissions: { canEdit, canManageShare: canEdit, canExport: !!r.allow_export && permissions.includes('reports.export') } satisfies DesignPermissions }];
  });
}

export async function getDesign(id: number): Promise<Design | null> {
  const [rows] = await getAppDb().execute('SELECT * FROM designed_reports WHERE id=?', [id]);
  const row = (rows as Row[])[0];
  if (!row) return null;
  const [shares] = await getAppDb().execute('SELECT audience_type, audience_id FROM designed_report_audiences WHERE report_id=?', [id]);
  const audience: ShareAudience = { users: [], roles: [], departments: [] };
  for (const item of shares as { audience_type: string; audience_id: string }[]) {
    if (item.audience_type === 'user') audience.users.push(Number(item.audience_id));
    if (item.audience_type === 'role') audience.roles.push(item.audience_id);
    if (item.audience_type === 'department') audience.departments.push(Number(item.audience_id));
  }
  return toDesign(row, audience);
}

export async function createDesign(workspaceId: string, userId: number, title?: string) {
  const spec = { ...emptySpec(), ...(title ? { title } : {}) };
  const [result] = await getAppDb().execute('INSERT INTO designed_reports (workspace_id, title, spec_json, messages_json, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [workspaceId, spec.title, JSON.stringify(spec), '[]', userId, userId]);
  return (result as { insertId: number }).insertId;
}

export async function updateShare(id: number, userId: number, input: { published: boolean; scope: ShareScope; allowExport: boolean; audience: ShareAudience }) {
  const db = await getAppDb().getConnection();
  try {
    await db.beginTransaction();
    await db.execute('UPDATE designed_reports SET published=?, share_scope=?, allow_export=?, updated_by=? WHERE id=?', [input.published ? 1 : 0, input.published ? input.scope : 'private', input.allowExport ? 1 : 0, userId, id]);
    await db.execute('DELETE FROM designed_report_audiences WHERE report_id=?', [id]);
    if (input.published && input.scope === 'selected') {
      for (const audienceId of input.audience.users) await db.execute("INSERT INTO designed_report_audiences (report_id, audience_type, audience_id) VALUES (?, 'user', ?)", [id, String(audienceId)]);
      for (const audienceId of input.audience.roles) await db.execute("INSERT INTO designed_report_audiences (report_id, audience_type, audience_id) VALUES (?, 'role', ?)", [id, audienceId]);
      for (const audienceId of input.audience.departments) await db.execute("INSERT INTO designed_report_audiences (report_id, audience_type, audience_id) VALUES (?, 'department', ?)", [id, String(audienceId)]);
    }
    await db.commit();
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}

/** Saves the spec (and chat) and keeps the previous spec as a version. */
export async function saveDesign(id: number, userId: number, spec: Spec, messages: Message[] | null, note: string) {
  const before = await getDesign(id);
  if (!before) throw new Error('Report not found.');
  const db = await getAppDb().getConnection();
  try {
    await db.beginTransaction();
    if (JSON.stringify(before.spec) !== JSON.stringify(spec)) {
      await db.execute('INSERT INTO designed_report_versions (report_id, spec_json, note, created_by) VALUES (?, ?, ?, ?)', [id, JSON.stringify(before.spec), note.slice(0, 300), userId]);
      await db.execute('DELETE FROM designed_report_versions WHERE report_id=? AND id NOT IN (SELECT id FROM (SELECT id FROM designed_report_versions WHERE report_id=? ORDER BY id DESC LIMIT 50) keep)', [id, id]);
    }
    await db.execute('UPDATE designed_reports SET title=?, spec_json=?, messages_json=?, updated_by=? WHERE id=?', [spec.title.slice(0, 200) || 'Untitled report', JSON.stringify(spec), JSON.stringify((messages ?? before.messages).slice(-200)), userId, id]);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}

export async function listVersions(id: number) {
  const [rows] = await getAppDb().execute('SELECT id, note, created_at FROM designed_report_versions WHERE report_id=? ORDER BY id DESC LIMIT 50', [id]);
  return rows as { id: number; note: string; created_at: string }[];
}
export async function getVersion(id: number, versionId: number) {
  const [rows] = await getAppDb().execute('SELECT spec_json FROM designed_report_versions WHERE report_id=? AND id=?', [id, versionId]);
  const row = (rows as { spec_json: string }[])[0];
  return row ? parseSpec(row.spec_json) : null;
}
export async function deleteDesign(id: number) { await getAppDb().execute('DELETE FROM designed_reports WHERE id=?', [id]); }
