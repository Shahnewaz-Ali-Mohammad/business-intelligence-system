import { NextRequest, NextResponse } from 'next/server';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { scopeProcedureValues } from '@/lib/access/data-scope.mjs';
import { audit } from '@/lib/access/access-db';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getSource } from '@/lib/tool-setup/store';
import { sensitiveOutput } from '@/lib/tool-setup/connectors.mjs';
import { authorizeProcedureRun } from '@/lib/tool-setup/report-procedures.mjs';
import { procedureMetadata, readApprovals } from '@/lib/tool-setup/procedure-metadata';
import { createRun } from '@/lib/tool-setup/procedure-run-store.mjs';
import { launchProcedureRun, pruneProcedureRuns } from '@/lib/tool-setup/procedure-runs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { getAppDb } from '@/lib/db/app-db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Running needs procedures.run; reviewing and approving procedures is setup work. */
async function context(id: string, sourceId: string, need: 'procedures.run' | 'setup.manage' | 'either') {
  const guard = await requireAccess();
  if (denied(guard)) throw new Error('Sign in to continue.');
  const { user, access } = guard;
  const allowed = need === 'either' ? access.permissions.includes('procedures.run') || access.permissions.includes('setup.manage') : access.permissions.includes(need);
  if (!allowed) throw new Error('Your role does not allow this.');
  const workspace = await getWorkspace(id);
  if (!workspace || !canOpenWorkspace(access)) throw new Error('Workspace unavailable.');
  const source = await getSource(id, sourceId);
  if (source.config.dialect !== 'sqlserver') throw new Error('Report procedure execution currently supports SQL Server databases only.');
  return { user, source, access };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sourceId = req.nextUrl.searchParams.get('sourceId') || '';
    const { source } = await context(id, sourceId, 'either');
    const requestedId = Number(req.nextUrl.searchParams.get('procedureId'));
    const procedures = await procedureMetadata(source.config, Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : undefined);
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
    const { user, source, access } = await context(id, body.sourceId, body.action === 'approve' ? 'setup.manage' : 'procedures.run');
    if (body.action === 'run' && body.sessionId) {
      const [sessions] = await getAppDb().execute("SELECT id FROM chat_sessions WHERE id=? AND user_id=? AND warehouse_id=? AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.session_id=chat_sessions.id AND JSON_UNQUOTE(JSON_EXTRACT(m.report_data, '$.workspaceToolAnswer.sourceId'))<>?)", [body.sessionId, user.id, id, body.sourceId]);
      if (!(sessions as unknown[]).length) throw new Error('This conversation belongs to another workspace or database.');
    }
    const [procedure] = await procedureMetadata(source.config, body.procedureId);
    if (!procedure || !procedure.allowed) throw new Error(procedure?.reason || 'Procedure unavailable.');
    if (procedure.parameters.some(p => sensitiveOutput(p.name))) throw new Error('Procedures requiring credentials or secret parameters are not supported for reporting.');
    if (body.action === 'approve') {
      if (body.reviewed !== true || body.hash !== procedure.hash) throw new Error('Review the current procedure definition first.');
      await getAppDb().execute("UPDATE bi_tool_sources SET catalog_json=JSON_SET(catalog_json, '$.reportProcedureApprovals', JSON_SET(COALESCE(JSON_EXTRACT(catalog_json, '$.reportProcedureApprovals'), JSON_OBJECT()), ?, ?)) WHERE id=?", [`$.\"${procedure.id}\"`, procedure.hash, body.sourceId]);
      return NextResponse.json({ approved: true });
    }
    const approvals = await readApprovals(body.sourceId);
    authorizeProcedureRun(procedure, approvals[String(procedure.id)], body);
    // Department access: the CEO runs freely; others only with the department
    // parameter forced to their own value.
    body.values = scopeProcedureValues({ procedure, values: body.values || {}, access, policy: access.allData ? null : await access.policyFor?.(source.config) });
    void audit(user.id, 'procedure.run', `${procedure.schema}.${procedure.name}`, { workspaceId: id, sourceId: body.sourceId });
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
      const run = await createRun(id, { sourceId: body.sourceId, userId: user.id, sessionId, procedure: { id: procedure.id, schema: procedure.schema, name: procedure.name, parameters: procedure.parameters, hash: procedure.hash }, values: body.values, omitted: body.omitted || [], allowBusinessWrites: body.allowBusinessWrites === true });
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
