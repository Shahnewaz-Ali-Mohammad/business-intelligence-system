import { enterAccess } from '@/lib/access/data-scope.mjs';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';
import { audit, getPolicy, savePolicy, sourceKey, listDepartments, type DataPolicy } from '@/lib/access/access-db';
import { getSource, listSetup } from '@/lib/tool-setup/store';
import { loadAccess } from '@/lib/access/access-db';
import { scopeToolParameters } from '@/lib/access/data-scope.mjs';
import { withDatabase } from '@/lib/tool-setup/connectors.mjs';
import { quote } from '@/lib/tool-setup/model.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

type CatalogObject = { id: string; schema: string; name: string; kind: string; columns: { name: string; dataType: string }[] };

/**
 * Without ?sourceId: every connected database. With it: its tables, columns,
 * stored procedures and current rules. With &field=: the values stored in that
 * column, to map them to departments.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const sourceId = req.nextUrl.searchParams.get('sourceId');
  const db = getAppDb();
  if (!sourceId) {
    const [rows] = await db.execute('SELECT src.id, src.database_name, w.id AS workspace_id, w.name AS workspace_name, (SELECT COUNT(*) FROM data_policies p WHERE p.source_id=src.id) AS configured FROM bi_tool_sources src JOIN bi_tool_servers srv ON srv.id=src.server_id JOIN workspaces w ON w.id=srv.workspace_id ORDER BY w.name, src.database_name');
    return NextResponse.json({ sources: (rows as Record<string, unknown>[]).map((r) => ({ id: r.id, database: r.database_name, workspaceId: r.workspace_id, workspace: r.workspace_name, configured: Number(r.configured) > 0 })) });
  }
  const [owner] = await db.execute('SELECT srv.workspace_id FROM bi_tool_sources src JOIN bi_tool_servers srv ON srv.id=src.server_id WHERE src.id=?', [sourceId]);
  const workspaceId = (owner as { workspace_id: string }[])[0]?.workspace_id;
  if (!workspaceId) return NextResponse.json({ error: 'Database not found.' }, { status: 404 });
  const source = await getSource(workspaceId, sourceId);
  const objects = ((source.catalog?.objects || []) as CatalogObject[]);
  // "View as": what one person would get from one table under the saved rules.
  const previewUser = Number(req.nextUrl.searchParams.get('previewUser'));
  const previewTable = req.nextUrl.searchParams.get('table');
  if (previewUser && previewTable) {
    const person = await loadAccess(previewUser);
    const policy = await getPolicy(sourceId);
    const setup = await listSetup(workspaceId);
    const tool = setup.tools.find((t) => t.sourceId === sourceId && t.status === 'approved' && t.definition.base === previewTable && t.definition.capabilities)
      || setup.tools.find((t) => t.sourceId === sourceId && t.status === 'approved' && t.definition.base === previewTable);
    if (!person.dataRole) return NextResponse.json({ outcome: 'blocked', message: 'This person has no data role (Admin only), so they see no business data.' });
    if (!tool) return NextResponse.json({ outcome: 'blocked', message: 'No approved tool reads this table, so nobody can query it in chat.' });
    try {
      const scoped = scopeToolParameters({ definition: tool.definition, catalog: source.catalog, parameters: tool.definition.capabilities ? { query: '{}' } : {}, access: person, policy });
      const where = tool.definition.capabilities ? JSON.parse(String((scoped as { query?: string }).query || '{}')).where : null;
      return NextResponse.json(where ? { outcome: 'filtered', message: `Only rows where ${where.field.split(':').pop()} is one of: ${where.value.join(', ')}`, departments: person.departmentNames } : { outcome: 'all', message: person.allData ? 'Sees every row (CEO).' : 'Sees every row (shared table).', departments: person.departmentNames });
    } catch (error) {
      return NextResponse.json({ outcome: 'blocked', message: error instanceof Error ? error.message : 'Blocked.', departments: person.departmentNames });
    }
  }
  const field = req.nextUrl.searchParams.get('field');
  if (field) {
    const [objectId, column] = [field.slice(0, field.indexOf(':')), field.slice(field.indexOf(':') + 1)];
    const object = objects.find((o) => o.id === objectId && o.kind !== 'procedure');
    if (!object || !object.columns.some((c) => c.name === column)) return NextResponse.json({ error: 'Unknown column.' }, { status: 400 });
    const dialect = source.config.dialect;
    const table = `${quote(object.schema, dialect)}.${quote(object.name, dialect)}`;
    const col = quote(column, dialect);
    const sql = dialect === 'sqlserver'
      ? `SELECT DISTINCT TOP 300 ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL ORDER BY 1`
      : `SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT 300`;
    try {
      const rows = (await withDatabase(source.config, (query: (sql: string) => Promise<{ v: unknown }[]>) => query(sql))) as { v: unknown }[];
      return NextResponse.json({ values: rows.map((r) => String(r.v)), complete: rows.length < 300 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read values.' }, { status: 400 });
    }
  }
  return NextResponse.json({
    source: { id: sourceId, database: source.config.database, workspaceId },
    tables: objects.filter((o) => o.kind !== 'procedure').map((o) => ({ id: o.id, name: `${o.schema}.${o.name}`, kind: o.kind, columns: o.columns.map((c) => ({ name: c.name, dataType: c.dataType })) })),
    procedures: objects.filter((o) => o.kind === 'procedure').map((o) => ({ id: o.id.split('#').pop(), name: `${o.schema}.${o.name}`, parameters: ((o as unknown as { parameters?: { name: string }[] }).parameters || []).map((p) => p.name) })),
    policy: (await getPolicy(sourceId)) || { tables: {}, departmentValues: {}, procedures: {} },
    departments: await listDepartments(),
  });
}

const Policy = z.object({
  departmentField: z.string().max(400).optional(),
  departmentValues: z.record(z.string().regex(/^\d+$/), z.array(z.string().max(200)).max(100)).default({}),
  tables: z.record(z.string().max(400), z.enum(['department', 'shared', 'restricted'])).default({}),
  procedures: z.record(z.string().regex(/^\d+$/), z.object({ parameter: z.string().min(1).max(130) }).strict()).default({}),
}).strict();

/** Saves a database's rules. Changes take effect on the next question. */
export async function PUT(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const guard = await requireAccess('users.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const body = await req.json().catch(() => null);
  const parsed = z.object({ sourceId: z.string().min(1).max(64), policy: Policy }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid rules.' }, { status: 400 });
  const { sourceId, policy } = parsed.data;
  const [owner] = await getAppDb().execute('SELECT srv.workspace_id FROM bi_tool_sources src JOIN bi_tool_servers srv ON srv.id=src.server_id WHERE src.id=?', [sourceId]);
  const workspaceId = (owner as { workspace_id: string }[])[0]?.workspace_id;
  if (!workspaceId) return NextResponse.json({ error: 'Database not found.' }, { status: 404 });
  const source = await getSource(workspaceId, sourceId);
  const objects = (source.catalog?.objects || []) as CatalogObject[];
  if (Object.keys(policy.tables).some((id) => !objects.some((o) => o.id === id))) return NextResponse.json({ error: 'Unknown table in the rules.' }, { status: 400 });
  if (Object.values(policy.tables).includes('department')) {
    const field = policy.departmentField || '';
    const object = objects.find((o) => o.id === field.slice(0, field.indexOf(':')));
    if (!object || !object.columns.some((c) => c.name === field.slice(field.indexOf(':') + 1))) return NextResponse.json({ error: 'Choose the column that holds each record’s department.' }, { status: 400 });
  }
  const departments = new Set((await listDepartments()).map((d) => String(d.id)));
  if (Object.keys(policy.departmentValues).some((id) => !departments.has(id))) return NextResponse.json({ error: 'Unknown department in the rules.' }, { status: 400 });
  await savePolicy(sourceId, sourceKey(source.config), policy as DataPolicy, guard.user.id);
  await audit(guard.user.id, 'data_access.changed', source.config.database, { sourceId, policy });
  return NextResponse.json({ ok: true });
}
