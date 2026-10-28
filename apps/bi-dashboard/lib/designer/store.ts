import { getAppDb } from '@/lib/db/app-db';
import { SpecSchema, emptySpec, type Message, type Spec } from './spec';

type Row = { id: number; workspace_id: string; title: string; spec_json: string; messages_json: string; created_by: number; updated_at: string; created_at: string };

export type Design = { id: number; workspaceId: string; title: string; spec: Spec; messages: Message[]; createdBy: number; updatedAt: string };

const parseSpec = (text: string): Spec => { try { return SpecSchema.parse(JSON.parse(text)); } catch { return emptySpec(); } };
const parseMessages = (text: string): Message[] => { try { const m = JSON.parse(text); return Array.isArray(m) ? m : []; } catch { return []; } };
const toDesign = (r: Row): Design => ({ id: r.id, workspaceId: r.workspace_id, title: r.title, spec: parseSpec(r.spec_json), messages: parseMessages(r.messages_json), createdBy: r.created_by, updatedAt: r.updated_at });

/** True once report-designer-migration.sql has been imported. */
export async function designerReady() {
  try { await getAppDb().query('SELECT 1 FROM designed_reports LIMIT 0'); return true; } catch { return false; }
}

export async function listDesigns(workspaceIds: 'all' | string[]) {
  if (workspaceIds !== 'all' && !workspaceIds.length) return [];
  const where = workspaceIds === 'all' ? '' : `WHERE workspace_id IN (${workspaceIds.map(() => '?').join(',')})`;
  const [rows] = await getAppDb().query(`SELECT id, workspace_id, title, spec_json, created_by, updated_at, created_at FROM designed_reports ${where} ORDER BY updated_at DESC LIMIT 200`, workspaceIds === 'all' ? [] : workspaceIds);
  return (rows as Row[]).map((r) => { const spec = parseSpec(r.spec_json); return { id: r.id, workspaceId: r.workspace_id, title: r.title, blocks: spec.blocks.length, updatedAt: r.updated_at, createdAt: r.created_at }; });
}

export async function getDesign(id: number): Promise<Design | null> {
  const [rows] = await getAppDb().execute('SELECT * FROM designed_reports WHERE id=?', [id]);
  const row = (rows as Row[])[0];
  return row ? toDesign(row) : null;
}

export async function createDesign(workspaceId: string, userId: number, title?: string) {
  const spec = { ...emptySpec(), ...(title ? { title } : {}) };
  const [result] = await getAppDb().execute('INSERT INTO designed_reports (workspace_id, title, spec_json, messages_json, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [workspaceId, spec.title, JSON.stringify(spec), '[]', userId, userId]);
  return (result as { insertId: number }).insertId;
}

/** Saves the spec (and chat) and keeps the previous spec as a version. */
export async function saveDesign(id: number, userId: number, spec: Spec, messages: Message[] | null, note: string) {
  const db = getAppDb();
  const before = await getDesign(id);
  if (!before) throw new Error('Report not found.');
  if (JSON.stringify(before.spec) !== JSON.stringify(spec)) {
    await db.execute('INSERT INTO designed_report_versions (report_id, spec_json, note, created_by) VALUES (?, ?, ?, ?)', [id, JSON.stringify(before.spec), note.slice(0, 300), userId]);
    await db.execute('DELETE FROM designed_report_versions WHERE report_id=? AND id NOT IN (SELECT id FROM (SELECT id FROM designed_report_versions WHERE report_id=? ORDER BY id DESC LIMIT 50) keep)', [id, id]);
  }
  await db.execute('UPDATE designed_reports SET title=?, spec_json=?, messages_json=?, updated_by=? WHERE id=?', [spec.title.slice(0, 200) || 'Untitled report', JSON.stringify(spec), JSON.stringify((messages ?? before.messages).slice(-200)), userId, id]);
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
