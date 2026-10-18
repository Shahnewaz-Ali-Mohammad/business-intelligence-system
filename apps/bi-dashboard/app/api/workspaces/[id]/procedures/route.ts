import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getSource } from '@/lib/tool-setup/store';
import { withDatabase, sensitiveOutput } from '@/lib/tool-setup/connectors.mjs';
import { reviewProcedure, procedureHash, procedureDefaults, authorizeProcedureRun } from '@/lib/tool-setup/report-procedures.mjs';
import { createRun } from '@/lib/tool-setup/procedure-run-store.mjs';
import { launchProcedureRun, pruneProcedureRuns } from '@/lib/tool-setup/procedure-runs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { getAppDb } from '@/lib/db/app-db';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function readApprovals(sourceId: string): Promise<Record<string, string>> {
  const [rows] = await getAppDb().execute("SELECT JSON_EXTRACT(catalog_json, '$.reportProcedureApprovals') AS approvals FROM bi_tool_sources WHERE id=?", [sourceId]);
  const value = (rows as { approvals?: string | Record<string, string> }[])[0]?.approvals;
  return typeof value === 'string' ? JSON.parse(value) : value || {};
}

async function context(id: string, sourceId: string) {
  const user = await getCurrentUser();
  const workspace = user && await getWorkspace(id);
  if (!user || workspace?.ownerUserId !== user.id) throw new Error('Workspace unavailable.');
  const source = await getSource(id, sourceId);
  if (source.config.dialect !== 'sqlserver') throw new Error('Report procedure execution currently supports SQL Server databases only.');
  return { user, source };
}

type ParameterMetadata = { name: string; type: string; baseType: string; output: boolean; maxLength: number; precision: number; scale: number; hasDefault?: boolean; tableType?: string; nullable?: boolean; tableColumns?: ParameterMetadata[] };
type ProcedureMetadata = { id: number; schema: string; name: string; definition: string; hash: string; allowed: boolean; reason: string; requiresWriteConsent: boolean; parameters: ParameterMetadata[] };
async function metadata(config: unknown, routineId?: number): Promise<ProcedureMetadata[]> {
  return withDatabase(config, async (query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>) => {
    const procedures = await query(`SELECT p.object_id AS id,s.name AS schema_name,p.name,${routineId ? 'm.definition' : 'NULL AS definition'} FROM sys.procedures p JOIN sys.schemas s ON s.schema_id=p.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=p.object_id WHERE p.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(p.name),'OBJECT','EXECUTE')=1${routineId ? ' AND p.object_id=@p1' : ''} ORDER BY s.name,p.name`, routineId ? [routineId] : []);
    if (!routineId) return procedures.map(p => ({ id: Number(p.id), schema: String(p.schema_name), name: String(p.name), definition: '', hash: '', allowed: false, reason: '', requiresWriteConsent: false, parameters: [] }));
    const parameters = await query(`SELECT p.name,t.name AS type,TYPE_NAME(p.system_type_id) AS base_type,p.is_output AS output,p.max_length,p.precision,p.scale,p.has_default_value,t.is_table_type,ts.name AS type_schema,tt.type_table_object_id FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id JOIN sys.schemas ts ON ts.schema_id=t.schema_id LEFT JOIN sys.table_types tt ON tt.user_type_id=p.user_type_id WHERE p.object_id=@p1 AND p.parameter_id>0 ORDER BY p.parameter_id`, [routineId]);
    const columns = await query(`SELECT tt.type_table_object_id,c.name,t.name AS type,TYPE_NAME(c.system_type_id) AS base_type,c.max_length,c.precision,c.scale,c.is_nullable FROM sys.parameters p JOIN sys.table_types tt ON tt.user_type_id=p.user_type_id JOIN sys.columns c ON c.object_id=tt.type_table_object_id JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE p.object_id=@p1 ORDER BY c.column_id`, [routineId]);
    const scalar = (param: Record<string, unknown>): ParameterMetadata => ({ name: String(param.name), type: String(param.type), baseType: String(param.base_type || param.type), output: Boolean(param.output), maxLength: Number(param.max_length), precision: Number(param.precision), scale: Number(param.scale), nullable: Boolean(param.is_nullable) });
    return procedures.map(p => {
      const definition = p.definition ? String(p.definition) : '';
      const defaults = procedureDefaults(definition, parameters) as Record<string, boolean>;
      const parsed = parameters.map(param => ({ ...scalar(param), hasDefault: Boolean(param.has_default_value || defaults[String(param.name)]), ...(param.is_table_type ? { tableType: `[${String(param.type_schema).replace(/]/g, ']]')}].[${String(param.type).replace(/]/g, ']]')}]`, tableColumns: columns.filter(c => Number(c.type_table_object_id) === Number(param.type_table_object_id)).map(scalar) } : {}) }));
      return { id: Number(p.id), schema: String(p.schema_name), name: String(p.name), definition, hash: procedureHash(JSON.stringify({ definition, parameters: parsed })), ...reviewProcedure(definition), parameters: parsed };
    });
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sourceId = req.nextUrl.searchParams.get('sourceId') || '';
    const { source } = await context(id, sourceId);
    const requestedId = Number(req.nextUrl.searchParams.get('procedureId'));
    const procedures = await metadata(source.config, Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : undefined);
    const approvals = await readApprovals(sourceId);
    return NextResponse.json({ procedures: procedures.map(p => ({ ...p, definition: requestedId ? p.definition : '', approved: approvals[String(p.id)] === p.hash })) });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not list procedures.' }, { status: 400 }); }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !Number.isSafeInteger(body.procedureId) || body.procedureId <= 0 || typeof body.sourceId !== 'string' || !['approve', 'run'].includes(body.action)) return NextResponse.json({ error: 'Invalid report request.' }, { status: 400 });
  if (body.sessionId != null && (!Number.isSafeInteger(body.sessionId) || body.sessionId <= 0)) return NextResponse.json({ error: 'Invalid chat session.' }, { status: 400 });
  try {
    const { user, source } = await context(id, body.sourceId);
    if (body.action === 'run' && body.sessionId) {
      const [sessions] = await getAppDb().execute("SELECT id FROM chat_sessions WHERE id=? AND user_id=? AND warehouse_id=? AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.session_id=chat_sessions.id AND JSON_UNQUOTE(JSON_EXTRACT(m.report_data, '$.workspaceToolAnswer.sourceId'))<>?)", [body.sessionId, user.id, id, body.sourceId]);
      if (!(sessions as unknown[]).length) throw new Error('This conversation belongs to another workspace or database.');
    }
    const [procedure] = await metadata(source.config, body.procedureId);
    if (!procedure || !procedure.allowed) throw new Error(procedure?.reason || 'Procedure unavailable.');
    if (procedure.parameters.some(p => sensitiveOutput(p.name))) throw new Error('Procedures requiring credentials or secret parameters are not supported for reporting.');
    if (body.action === 'approve') {
      if (body.reviewed !== true || body.hash !== procedure.hash) throw new Error('Review the current procedure definition first.');
      await getAppDb().execute("UPDATE bi_tool_sources SET catalog_json=JSON_SET(catalog_json, '$.reportProcedureApprovals', JSON_SET(COALESCE(JSON_EXTRACT(catalog_json, '$.reportProcedureApprovals'), JSON_OBJECT()), ?, ?)) WHERE id=?", [`$.\"${procedure.id}\"`, procedure.hash, body.sourceId]);
      return NextResponse.json({ approved: true });
    }
    const approvals = await readApprovals(body.sourceId);
    authorizeProcedureRun(procedure, approvals[String(procedure.id)], body);
    // The procedure runs in a background worker that streams every row to
    // storage; the chat answer is created now and completed by the worker.
    const title = `${procedure.schema}.${procedure.name}`;
    const db = await getAppDb().getConnection();
    let answer;
    try {
      await db.beginTransaction();
      let sessionId = body.sessionId;
      if (sessionId) {
        const [sessions] = await db.execute('SELECT id FROM chat_sessions WHERE id=? AND user_id=? AND warehouse_id=?', [sessionId, user.id, id]);
        if (!(sessions as unknown[]).length) throw new Error('Chat session unavailable.');
      } else {
        const [created] = await db.execute('INSERT INTO chat_sessions(user_id,title,warehouse_id) VALUES(?,?,?)', [user.id, title, id]);
        sessionId = (created as { insertId: number }).insertId;
      }
      const run = await createRun(id, { sourceId: body.sourceId, userId: user.id, sessionId, procedure: { id: procedure.id, schema: procedure.schema, name: procedure.name, parameters: procedure.parameters }, values: body.values, omitted: body.omitted || [], allowBusinessWrites: body.allowBusinessWrites === true });
      answer = { title, narrative: `Running ${title}…`, rows: [], columns: [], procedure: { id: procedure.id, name: title, values: body.values, omitted: body.omitted || [], runId: run.id, writeAuthorized: body.allowBusinessWrites === true }, sourceId: body.sourceId, sessionId, hasMore: false, scope: 'Complete procedure result' };
      await db.execute('INSERT INTO chat_messages(user_id,session_id,role,content,report_data) VALUES(?,?,?,?,?)', [user.id, sessionId, 'user', `/${title} ${JSON.stringify(body.values)}`, null]);
      const [assistant] = await db.execute('INSERT INTO chat_messages(user_id,session_id,role,content,report_data) VALUES(?,?,?,?,?)', [user.id, sessionId, 'assistant', answer.narrative, JSON.stringify({ workspaceToolAnswer: answer })]);
      await db.execute('UPDATE chat_sessions SET updated_at=NOW() WHERE id=?', [sessionId]);
      await db.commit();
      const { writeRun, readRun } = await import('@/lib/tool-setup/procedure-run-store.mjs');
      const saved = await readRun(id, run.id);
      await writeRun(id, { ...saved, messageId: (assistant as { insertId: number }).insertId });
      launchProcedureRun(id, run.id);
    } catch (e) { await db.rollback(); throw e; } finally { db.release(); }
    void pruneProcedureRuns(id, user.id).catch(() => {});
    return NextResponse.json(answer);
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Report failed.' }, { status: 400 }); }
}
