import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from '../../bi-warehouse/node_modules/pg/lib/index.js';
import mysql from 'mysql2/promise';
import { workspaceCubeLoad } from '../../bi-warehouse/src/services/workspaceCube.mjs';
import { parseModel, modelCatalog } from '../../bi-warehouse/src/semantic/warehouseModel.mjs';
import { collectReportSummary } from '../../bi-warehouse/src/semantic/reportSummary.mjs';
import { graphOptions, defaultGraph, normalizeGraph } from '../../bi-warehouse/src/semantic/reportGraph.mjs';

const base = process.env.TEST_APP_URL || 'http://localhost:3000';
const suffix = crypto.randomBytes(5).toString('hex');
const schema = `bi_onboarding_test_${suffix}`;
const env = process.env;
const pgConfig = { host: env.WAREHOUSE_PG_HOST, port: Number(env.WAREHOUSE_PG_PORT || 5432), database: env.WAREHOUSE_PG_DATABASE, user: env.WAREHOUSE_PG_USER, password: env.WAREHOUSE_PG_PASSWORD };
const database = new pg.Client(pgConfig);
const app = await mysql.createConnection({ host: env.DB_APP_HOST, port: Number(env.DB_APP_PORT || 3306), database: env.DB_APP_NAME, user: env.DB_APP_USER, password: env.DB_APP_PASSWORD });
const userIds = [];
const audit = [];
const auditPath = process.env.TEST_AUDIT_PATH || '/private/tmp/bi-flow-audit.json';
let cookie, workspaceId;
async function request(path, body, auth = cookie, method = body ? 'POST' : 'GET', retry = 0) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(auth ? { Cookie: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
  const data = await response.json();
  if (response.status === 429 && process.env.TEST_EXHAUSTIVE === '1' && retry < 2) {
    console.log('Respecting API rate limit before continuing the QA matrix.');
    await new Promise((resolve) => setTimeout(resolve, 61000));
    return request(path, body, auth, method, retry + 1);
  }
  return { status: response.status, data, response };
}
async function register(label) {
  const result = await request('/api/auth/register', { email: `warehouse-test-${suffix}-${label}@example.invalid`, password: process.env.TEST_GRAPH_UI === '1' ? 'Graph-QA-Only-2026!' : crypto.randomBytes(20).toString('hex'), displayName: 'Warehouse Integration Test' }, '');
  assert.equal(result.status, 200); userIds.push(result.data.user.id);
  return result.response.headers.get('set-cookie').split(';')[0];
}
function check(label, condition) { assert.ok(condition, label); console.log(`PASS ${label}`); }
try {
  await database.connect();
  await database.query(`CREATE SCHEMA "${schema}"`);
  await database.query(`CREATE TABLE "${schema}"."TicketType"("TicketTypeID" integer PRIMARY KEY,"TicketTypeName" text);
    CREATE TABLE "${schema}"."TicketStatus"("TicketStatusID" integer PRIMARY KEY,"TicketStatusName" text);
    CREATE TABLE "${schema}"."Tickets"("TicketId" text PRIMARY KEY,"TicketTypeID" integer REFERENCES "${schema}"."TicketType","TicketStatusID" integer REFERENCES "${schema}"."TicketStatus","Subject" text,"Status" text,"Amount" numeric,"ElapsedHours" numeric,"CreatedAt" timestamp,"LinkId" text,"Password" text);
    CREATE TABLE "${schema}"."UserTokens"("Id" integer PRIMARY KEY,"Token" text);
    INSERT INTO "${schema}"."TicketType" VALUES(5,'Fiber Issue'),(23,'Packet Loss');
    INSERT INTO "${schema}"."TicketStatus" VALUES(1,'Open'),(2,'Resolved');
    INSERT INTO "${schema}"."Tickets" SELECT CASE WHEN i=1 THEN '0001' ELSE i::text END,CASE WHEN i%3=0 THEN 23 ELSE 5 END,CASE WHEN i%2=0 THEN 2 ELSE 1 END,'Synthetic ticket '||i,CASE WHEN i%2=0 THEN 'Resolved' ELSE 'Open' END,i,i%50,'2025-01-01'::timestamp+(i%30)*interval '1 day','L-'||i,'not-for-chat' FROM generate_series(1,2001) i;`);
  cookie = await register('owner');
  const created = await request('/api/workspaces', { name: `Warehouse Test ${suffix}` }); assert.equal(created.status, 201); workspaceId = created.data.workspace.id;
  const url = `postgresql://${encodeURIComponent(pgConfig.user)}:${encodeURIComponent(pgConfig.password)}@${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`;
  const discovered = await request(`/api/workspaces/${workspaceId}/warehouse`, { action: 'discover', connectionString: url, schemas: [schema] });
  assert.equal(discovered.status, 200, JSON.stringify(discovered.data));
  const discovery = discovered.data.discovery;
  check('schema discovery and declared relationships', discovery.tables.length === 4 && discovery.joins.length === 2);
  check('credentials never returned by discovery', !JSON.stringify(discovered.data).includes(pgConfig.password));
  check('external connection choice survives reopening', (await request(`/api/workspaces/${workspaceId}/warehouse`)).data.usesExistingWarehouse === false);
  const selectedTables = discovery.tables.filter((t) => !t.restricted).map((t) => t.key);
  const activated = await request(`/api/workspaces/${workspaceId}/warehouse`, { action: 'activate', selectedTables, approvedJoins: [], draftFingerprint: discovery.fingerprint });
  assert.equal(activated.status, 200, JSON.stringify(activated.data)); check('Cube compile and activation', activated.data.ready);
  const second = await register('other');
  check('cross-owner setup is denied', (await request(`/api/workspaces/${workspaceId}/warehouse`, undefined, second)).status === 404);
  check('unsigned internal credential access is denied', (await request('/api/internal/warehouse', undefined, '')).status === 403);
  if (process.env.TEST_LOCAL_ONLY !== '1') {
  const cases = [
    ['all records', 'Give me the full Tickets table with all available columns', 2001],
    ['named category', 'Give me all fiber tickets', 1334],
    ['exact leading-zero ID', 'Show Tickets details where TicketId equals 0001', 1],
    ['missing literal ID', 'Show Tickets details where TicketId equals 99999999', 0],
    ['numeric and category filters', 'List fiber tickets where Amount is at least 1000', 668],
    ['date filter', 'List tickets created in January 2024', 0],
    ['ranked top-N', 'Show the top 5 tickets by Amount, highest first', 5],
    ['combined OR filters', 'List tickets where Amount is less than 3 OR Amount is greater than 1999', 4],
  ];
  if (process.env.TEST_EXHAUSTIVE === '1') cases.push(
    ['one-column records', 'List only TicketId for every Tickets record, no other columns.', 2001],
    ['two-column records', 'List only TicketId and Amount for all Tickets records.', 2001],
    ['five-column records', 'List only TicketId, Amount, Status, CreatedAt and LinkId for every Tickets record.', 2001],
    ['total count', 'How many Tickets records are there? Return record count.', 1],
    ['amount aggregates', 'Show the sum and average of Amount across all Tickets records.', 1],
    ['status grouping', 'Count Tickets records grouped by Status.', 2],
    ['joined type grouping', 'Count Tickets records grouped by TicketTypeName, using the approved TicketType relationship.', 2],
    ['aggregate threshold', 'Count Tickets records grouped by Status, keep only groups with record count at least 1001.', 1],
    ['daily grouping', 'Count Tickets records per day of CreatedAt during January 2025.', 30],
    ['inclusive amount range', 'List every Tickets record with Amount between 10 and 20 inclusive.', 11],
    ['null filter', 'List Tickets records where LinkId is null.', 0],
    ['category exclusion', 'List Tickets records excluding the Fiber Issue ticket type.', 667],
    ['exact link lookup', 'Show all Tickets details where LinkId exactly equals L-42.', 1],
    ['unavailable field', 'Show the official SLA breach percentage for each Tickets record. There is no SLA definition in this model; do not guess one.', null],
  );
  if (process.env.TEST_EXTENDED === '1') cases.push(
    ['strict lower bound', 'List Tickets where Amount is greater than 2000.', 1],
    ['strict upper bound', 'List Tickets where Amount is less than 2.', 1],
    ['inclusive lower bound', 'List Tickets where Amount is at least 2000.', 2],
    ['inclusive upper bound', 'List Tickets where Amount is at most 2.', 2],
    ['numeric equality', 'List Tickets where Amount is exactly 42.', 1],
    ['numeric exclusion', 'List Tickets where Amount is not equal to 42.', 2000],
    ['contradictory filters', 'List Tickets where Amount is greater than 10 AND less than 5. Keep both filters, even though no records can match.', 0],
    ['outer AND with OR', 'List Fiber Issue tickets where (Amount is less than 3 OR Amount is greater than 1999). Keep the Fiber Issue constraint outside the OR group.', 3],
    ['category alternatives', 'List tickets whose type is Fiber Issue OR Packet Loss.', 2001],
    ['two lookup joins', 'List Packet Loss tickets with TicketStatusName equal to Resolved.', 333],
    ['positive null filter', 'List Tickets where LinkId is not null.', 2001],
    ['string prefix', 'List Tickets where LinkId starts with L-200.', 3],
    ['string suffix', 'List Tickets where LinkId ends with -42.', 1],
    ['string contains', 'List Tickets where Subject contains Synthetic ticket 200.', 3],
    ['exact text', 'List Tickets where Subject equals Synthetic ticket 42.', 1],
    ['quoted missing text', "List Tickets where Subject exactly equals O'Reilly. Keep the literal apostrophe.", 0],
    ['single day', 'List Tickets created on January 1, 2025.', 66],
    ['monthly grouping', 'Count Tickets grouped by month of CreatedAt during 2025.', 1],
    ['two category grouping', 'Count Tickets grouped by TicketTypeName and TicketStatusName using both approved lookup joins.', 4],
    ['empty aggregate threshold', 'Count Tickets grouped by Status and keep only groups with count above 2001.', 0],
    ['zero numeric values', 'List Tickets where ElapsedHours equals zero.', 40],
    ['negative numeric values', 'List Tickets where Amount is negative.', 0],
    ['restricted password', 'Show the Password column for every Tickets record.', null],
    ['unknown column', 'List the UnavailableCustomField for every ticket. Do not substitute another field.', null],
  );
  let full;
  for (const [label, message, expected] of cases) {
    if (process.env.TEST_GRAPHS_ONLY === '1' && label !== 'all records') continue;
    const started = Date.now();
    let chat;
    let reportId;
    try {
    chat = await request('/api/chat', { message, workspaceId, history: [] });
    assert.equal(chat.status, 200, JSON.stringify(chat.data));
    if (expected === null) {
      assert.equal(chat.data.askedClarification, true);
      assert.equal(chat.data.data, null);
    } else {
    assert.equal(chat.data.intent, 'create_new_page', 'Executable warehouse query must expose its report in chat');
    assert.equal(chat.data.data?.semanticQueryTotalCount, expected, `${label}: ${JSON.stringify(chat.data)}`);
    check(label, chat.data.title !== 'Query Results');
    if (process.env.TEST_EXHAUSTIVE === '1') {
      const table = chat.data.data.semanticQueryTable;
      const expectedColumns = { 'one-column records': ['TicketId'], 'two-column records': ['TicketId', 'Amount'], 'five-column records': ['TicketId', 'Amount', 'Status', 'CreatedAt', 'LinkId'] }[label];
      if (expectedColumns) assert.deepEqual([...table.headers].sort(), expectedColumns.sort(), 'Requested columns changed');
      if (label === 'strict lower bound') assert.equal(chat.data.data.semanticQuery.measures.length, 0, 'Record list must not become a count-by-record aggregate');
      if (label === 'total count') assert.equal(Number(table.rows[0][0]), 2001);
      if (label === 'amount aggregates') assert.deepEqual(table.rows[0].map(Number).sort((a,b) => a-b), [1001,2003001]);
      if (label === 'exact leading-zero ID' || label === 'exact link lookup') {
        assert.ok(!/average|median|100%/.test(chat.data.narrative), 'Specific lookup must describe the actual record');
        assert.ok(chat.data.narrative.includes(label === 'exact leading-zero ID' ? '0001' : 'L-42'));
      }
      if (label === 'status grouping') assert.deepEqual(table.rows.map((r) => Number(r.at(-1))).sort((a,b) => a-b), [1000,1001]);
      if (expected > 0) assert.ok(!/statistics could not be calculated|AI wording is unavailable/i.test(chat.data.narrative), 'Insight generation failed');
      const report = await request('/api/reports', { title: chat.data.title, narrative: chat.data.narrative, topic: chat.data.topic, chartType: 'none', data: chat.data.data, tablesUsed: chat.data.tablesUsed });
      assert.equal(report.status, 200);
      reportId = report.data.id;
      const reopenedReport = await request(`/api/reports/${report.data.id}`);
      assert.equal(reopenedReport.status, 200);
      assert.equal(reopenedReport.data.report.title, chat.data.title);
      assert.equal(reopenedReport.data.report.narrative, chat.data.narrative);
      const reportQuery = new URLSearchParams({ q: JSON.stringify(chat.data.data.semanticQuery), workspaceId, modelVersion: chat.data.data.warehouseQuery.modelVersion, page: '1', pageSize: '100', ...(chat.data.data.semanticQueryMaxRows ? { maxRows: String(chat.data.data.semanticQueryMaxRows) } : {}) });
      const reportPage = await request(`/api/lists/semantic?${reportQuery}`);
      assert.equal(reportPage.status, 200);
      assert.equal(reportPage.data.totalCount, expected);
      assert.deepEqual(reportPage.data.table.headers, table.headers);
      if (['one-column records', 'two-column records', 'five-column records', 'total count', 'amount aggregates', 'status grouping', 'joined type grouping', 'aggregate threshold', 'daily grouping'].includes(label)) {
        const [models] = await app.execute('SELECT confirmed_yaml FROM workspace_semantic_models WHERE workspace_id=?', [workspaceId]);
        const catalog = modelCatalog(parseModel(models[0].confirmed_yaml));
        const query = chat.data.data.semanticQuery;
        const options = graphOptions(catalog, query);
        const graph = await request('/api/graphs', { action: 'render', source: { query, workspaceId, modelVersion: chat.data.data.warehouseQuery.modelVersion }, spec: normalizeGraph(defaultGraph(options, query), options) });
        assert.equal(graph.status, 200, `Graph failed for ${label}: ${JSON.stringify(graph.data)}`);
        if (label === 'aggregate threshold') {
          assert.equal(graph.data.rows.length, 1);
          assert.equal(graph.data.rows[0].label, 'Open');
          assert.equal(Number(graph.data.rows[0].value), 1001);
          assert.deepEqual(graph.data.options.kinds, ['bar']);
        }
        if (label === 'joined type grouping' || label === 'status grouping') assert.equal(graph.data.rows.reduce((sum, r) => sum+Number(r.value),0), 2001);
        if (label === 'total count') assert.equal(Number(graph.data.rows[0].value), 2001);
      }
    }
    if (label === 'all records') { full = chat.data; check('chat preview remains 200 rows', full.data.semanticQueryTable.rows.length === 200); check('approved columns include LinkId and exclude Password', full.data.semanticQueryTable.headers.includes('LinkId') && !full.data.semanticQueryTable.headers.includes('Password')); }
    }
    audit.push({ label, message, expected, passed: true, reportId, milliseconds: Date.now()-started, reply: chat.data });
    } catch (error) {
      if (process.env.TEST_EXHAUSTIVE !== '1') throw error;
      audit.push({ label, message, expected, passed: false, milliseconds: Date.now()-started, error: error.message, reply: chat?.data });
      console.error(`FAIL ${label}: ${error.message}`);
      process.exitCode = 1;
    }
    if (process.env.TEST_EXHAUSTIVE === '1') await writeFile(auditPath, JSON.stringify(audit, null, 2));
  }
  if (process.env.TEST_FOLLOWUPS === '1') {
    let prior = await request('/api/chat', { message: 'List all Fiber Issue tickets, with TicketId, Status and Amount only.', workspaceId, history: [] });
    assert.equal(prior.data.data?.semanticQueryTotalCount, 1334);
    for (const [message, expected] of [['Now list all Packet Loss tickets, with TicketId, Status and Amount only.', 667], ['Remove the previous ticket type filter. List all ticket types with TicketId, Status and Amount only.', 2001]]) {
      const next = await request('/api/chat', { message, workspaceId, history: [{ role: 'assistant', content: prior.data.narrative }], pageState: { warehouseQuery: prior.data.data.warehouseQuery } });
      assert.equal(next.status, 200);
      assert.equal(next.data.data?.semanticQueryTotalCount, expected, JSON.stringify(next.data));
      assert.deepEqual([...next.data.data.semanticQueryTable.headers].sort(), ['Amount', 'Status', 'TicketId']);
      check(`follow-up ${expected === 667 ? 'category change' : 'all-types reset'} uses correct population and columns`, true);
      prior = next;
    }
  }
  if (process.env.TEST_FILTER_MATRIX === '1') {
    const [models] = await app.execute('SELECT confirmed_yaml FROM workspace_semantic_models WHERE workspace_id=?', [workspaceId]);
    const model = parseModel(models[0].confirmed_yaml), catalog = modelCatalog(model);
    const root = catalog.find((c) => c.table === `${schema}.Tickets`);
    const field = (title) => root.dimensions.find((f) => f.title === title).name;
    const lookup = (table, title) => catalog.find((c) => c.table === `${schema}.${table}`).dimensions.find((f) => f.title === title).name;
    const count = root.measures.find((m) => m.type === 'count').name;
    const scopes = [
      [[], 'TRUE'],
      [[{ member: field('TicketTypeID'), operator: 'equals', values: ['5'] }], '"TicketTypeID"=5'],
      [[{ member: field('TicketTypeID'), operator: 'equals', values: ['23'] }], '"TicketTypeID"=23'],
      [[{ member: field('Status'), operator: 'equals', values: ['Open'] }], '"Status"=\'Open\''],
      [[{ member: lookup('TicketType', 'TicketTypeName'), operator: 'equals', values: ['Packet Loss'] }], '"TicketTypeID"=23'],
      [[{ member: lookup('TicketStatus', 'TicketStatusName'), operator: 'equals', values: ['Resolved'] }], '"TicketStatusID"=2'],
    ];
    let checked = 0;
    for (const [operator, sqlOperator] of [['gt','>'],['gte','>='],['lt','<'],['lte','<='],['equals','='],['notEquals','<>']]) {
      for (const threshold of [-1,0,1,42,1000,2001,2002]) for (const [filters, scope] of scopes) {
        const query = { measures: [count], filters: [...filters, { member: field('Amount'), operator, values: [String(threshold)] }] };
        const actual = await workspaceCubeLoad({ model, ownerUserId: userIds[0] }, query);
        const expected = (await database.query(`SELECT count(*)::text AS n FROM "${schema}"."Tickets" WHERE ${scope} AND "Amount" ${sqlOperator} $1`, [threshold])).rows[0].n;
        assert.equal(String(actual.data[0]?.[count]), expected, `Filter combination ${operator} ${threshold} ${scope}`);
        checked++;
      }
    }
    for (const low of [0,2,20,1000,2000,2002]) for (const high of [0,2,20,1000,2000,2002]) {
      const filters = [{ or: [{ member: field('Amount'), operator: 'lt', values: [String(low)] }, { member: field('Amount'), operator: 'gt', values: [String(high)] }] }, { member: field('TicketTypeID'), operator: 'equals', values: ['5'] }];
      const actual = await workspaceCubeLoad({ model, ownerUserId: userIds[0] }, { measures: [count], filters });
      const expected = (await database.query(`SELECT count(*)::text AS n FROM "${schema}"."Tickets" WHERE ("Amount"<$1 OR "Amount">$2) AND "TicketTypeID"=5`, [low,high])).rows[0].n;
      assert.equal(String(actual.data[0]?.[count]), expected, `Nested OR ${low} ${high}`); checked++;
    }
    check(`${checked} executed numeric/filter/join combinations match direct SQL`, true);
  }
  const data = full.data, q = new URLSearchParams({ q: JSON.stringify(data.semanticQuery), workspaceId, modelVersion: data.warehouseQuery.modelVersion, page: '2', pageSize: '100' });
  const page = await request(`/api/lists/semantic?${q}`); assert.equal(page.status, 200); check('report page remains 100 rows with full count', page.data.table.rows.length === 100 && page.data.totalCount === 2001);
  const foreignPage = await request(`/api/lists/semantic?${q}`, undefined, second); check('cross-owner report query denied', foreignPage.status !== 200);
  const staleQuery = new URLSearchParams(q); staleQuery.set('modelVersion', '0'.repeat(64));
  check('stale report model denied', (await request(`/api/lists/semantic?${staleQuery}`)).status !== 200);
  const saved = await request('/api/reports', { title: full.title, narrative: full.narrative, topic: full.topic, chartType: 'none', data, tablesUsed: full.tablesUsed });
  assert.equal(saved.status, 200); check('warehouse query identity saves with report', saved.data.saved);
  if (process.env.TEST_INSIGHTS === '1') {
    const [models] = await app.execute('SELECT confirmed_yaml FROM workspace_semantic_models WHERE workspace_id=?', [workspaceId]);
    const model = parseModel(models[0].confirmed_yaml);
    const catalog = modelCatalog(model);
    const root = catalog.find((c) => c.table === `${schema}.Tickets`);
    const amount = root.dimensions.find((f) => f.title === 'Amount').name;
    const context = { model, ownerUserId: userIds[0] };
    const summarize = (query) => collectReportSummary(catalog, query, (q) => workspaceCubeLoad(context, q, 'sql'), async (statement) => (await database.query(statement)).rows[0].result);
    const summary = await summarize(data.semanticQuery);
    const stats = summary.numeric.find((f) => f.member === amount).statistics;
    check('full-population insight statistics ignore the 200-row preview', summary.population === '2001' && Number(stats.average) === 1001 && Number(stats.median) === 1001 && Number(stats.minimum) === 1 && Number(stats.maximum) === 2001);
    const filtered = await summarize({ ...data.semanticQuery, filters: [{ member: amount, operator: 'gte', values: ['1000'] }], limit: 5 });
    const filteredStats = filtered.numeric.find((f) => f.member === amount).statistics;
    check('insight filters persist while ranking limits do not truncate statistics', filtered.population === '1002' && Number(filteredStats.average) === 1500.5 && Number(filteredStats.median) === 1500.5);
    check('chat returns analytical content instead of the basic record-count template', /average|median|highest|lowest|range|\bmean\b/i.test(full.narrative) && !full.narrative.includes('statistics could not be calculated'));
  }
  if (process.env.TEST_GRAPHS === '1') {
    const graphSource = { query: data.semanticQuery, workspaceId, modelVersion: data.warehouseQuery.modelVersion };
    const generated = await request('/api/graphs', { action: 'generate', source: graphSource, title: 'Synthetic tickets by status' });
    assert.equal(generated.status, 200, JSON.stringify(generated.data)); check('on-demand graph recommendation renders', generated.data.rows.length > 0);
    const [modelRows] = await app.execute('SELECT confirmed_yaml FROM workspace_semantic_models WHERE workspace_id=?', [workspaceId]);
    const catalog = modelCatalog(parseModel(modelRows[0].confirmed_yaml));
    const root = catalog.find((c) => c.table === `${schema}.Tickets`);
    const member = (title) => root.dimensions.find((f) => f.title === title).name;
    const category = member('Status');
    const hiddenCategory = catalog.find((c) => c.table === `${schema}.TicketStatus`).dimensions.find((f) => f.title === 'TicketStatusName').name;
    check('graph options exclude related fields absent from report', !generated.data.options.categories.some((f) => f.name === hiddenCategory));
    const count = `${root.name}.record_count`;
    const config = { ...generated.data.spec, measure: count, dimension: category, time: member('CreatedAt'), x: member('Amount'), y: member('ElapsedHours'), filters: [], offset: 0, search: '', granularity: 'day' };
    check('column selector contains every returned field and its source table', graphSource.query.dimensions.every((name) => generated.data.options.columns.some((f) => f.name === name && f.table)));
    for (const [kind, field, title] of [['bar', 'dimension', 'TicketId'], ['bar', 'dimension', 'Status'], ['bar', 'dimension', 'Subject'], ['line', 'time', 'CreatedAt'], ['histogram', 'x', 'Amount']]) {
      const graph = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind, [field]: member(title) } });
      assert.equal(graph.status, 200, JSON.stringify(graph.data));
      check(`returned ${title} column supports its meaningful ${kind} view`, graph.data.rows.length > 0);
    }
    for (const pageSize of [20, 50, 100]) {
      const first = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', dimension: member('Subject'), pageSize, search: 'stale search that matches nothing' } });
      const next = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', dimension: member('Subject'), pageSize, offset: pageSize } });
      const last = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', dimension: member('Subject'), pageSize, offset: 2000 } });
      assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(next.status, 200, JSON.stringify(next.data)); assert.equal(last.status, 200, JSON.stringify(last.data));
      assert.equal(first.data.total, 2001); assert.equal(first.data.rows.length, pageSize); assert.equal(next.data.rows.length, pageSize); assert.equal(last.data.rows.length, 1);
      assert.ok(!next.data.rows.some((r) => first.data.rows.some((f) => f.label === r.label)));
      assert.equal(first.data.spec.search, '');
      check(`${pageSize}-group pages expose all 2001 groups without overlaps or hidden search`, true);
    }
    for (const kind of ['bar', 'line', 'kpi', 'histogram', 'scatter', 'density']) {
      const graph = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind } });
      assert.equal(graph.status, 200, `${kind}: ${JSON.stringify(graph.data)}`);
      assert.equal(graph.data.rows.reduce((sum, row) => sum + Number(row.value), 0), 2001, `${kind} full population`);
      if (['histogram', 'scatter', 'density'].includes(kind)) { assert.equal(graph.data.population, '2001'); assert.ok(graph.data.rows.length <= 400); }
      check(`${kind} uses all matching rows with bounded output`, true);
    }
    const focused = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', filters: [{ member: category, operator: 'equals', values: ['Open'] }] } });
    assert.equal(focused.data.rows[0].value, '1001'); check('graph drill-down filters execute in database', focused.status === 200);
    const histFiltered = await request('/api/graphs', { action: 'render', source: { ...graphSource, query: { ...graphSource.query, filters: [{ member: member('Amount'), operator: 'gte', values: ['1000'] }] } }, spec: { ...config, kind: 'histogram' } });
    assert.equal(histFiltered.data.population, '1002'); check('numeric bins preserve original report filters', histFiltered.status === 200);
    for (const [label, kind, operator, value, expected, mode] of [['small exact scatter', 'scatter', 'lte', '20', 20, 'points'], ['single constant histogram', 'histogram', 'equals', '42', 1, 'bins'], ['empty histogram', 'histogram', 'gte', '999999', 0, 'bins']]) {
      const graph = await request('/api/graphs', { action: 'render', source: { ...graphSource, query: { ...graphSource.query, filters: [{ member: member('Amount'), operator, values: [value] }] } }, spec: { ...config, kind } });
      assert.equal(graph.status, 200, JSON.stringify(graph.data));
      assert.equal(graph.data.population, String(expected)); assert.equal(graph.data.mode, mode);
      assert.equal(graph.data.rows.reduce((sum, row) => sum + Number(row.value), 0), expected);
      check(label, true);
    }
    check('cross-owner graph access denied', (await request('/api/graphs', { action: 'render', source: graphSource, spec: config }, second)).status === 403);
    check('invented graph field denied', (await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', measure: 'Invented.metric' } })).status !== 200);
    const outside = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', dimension: hiddenCategory } });
    check('existing but unreturned related graph field denied', outside.status === 422 && outside.data.options.categories.every((f) => f.name !== hiddenCategory));
    const joined = await request('/api/graphs', { action: 'render', source: { ...graphSource, query: { ...graphSource.query, dimensions: [...graphSource.query.dimensions, hiddenCategory] } }, spec: { ...config, kind: 'bar', dimension: hiddenCategory } });
    check('explicitly returned joined column remains graphable', joined.status === 200 && joined.data.rows.reduce((sum, row) => sum + Number(row.value), 0) === 2001);
    const chartSpec = { groups: [], reportGraph: { ...config, kind: 'bar', filters: [{ member: category, operator: 'equals', values: ['Open'] }] } };
    const patched = await request(`/api/reports/${saved.data.id}`, { chartSpec }, cookie, 'PATCH'); assert.equal(patched.status, 200);
    const restored = await request(`/api/reports/${saved.data.id}`); assert.deepEqual(restored.data.report.chart_spec, chartSpec); check('graph style and filtered state save and restore', true);
    check('cross-owner graph settings update denied', (await request(`/api/reports/${saved.data.id}`, { chartSpec }, second, 'PATCH')).status === 404);
    if (process.env.TEST_GRAPH_SCALE === '1') {
      const scale = Number(process.env.TEST_SCALE_ROWS || 62001);
      assert.ok(Number.isSafeInteger(scale) && scale >= 62001 && scale <= 1000000, 'Local physical load fixture is capped at one million rows');
      await database.query(`INSERT INTO "${schema}"."Tickets" SELECT i::text,5,1,'Synthetic scale ticket '||i,'Open',i,i%50,'2025-01-01'::timestamp,'L-'||i,'not-for-chat' FROM generate_series(2002,$1::integer) i`, [scale]);
      for (const kind of scale > 62001 ? ['bar', 'line', 'kpi', 'histogram', 'scatter', 'density'] : ['scatter']) {
        const started = Date.now();
        const large = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind } });
        assert.equal(large.status, 200, JSON.stringify(large.data));
        assert.equal(large.data.rows.reduce((sum, row) => sum + BigInt(row.value), 0n), BigInt(scale));
        if (['histogram', 'scatter', 'density'].includes(kind)) { assert.equal(large.data.population, String(scale)); assert.ok(large.data.rows.length <= 400); }
        check(`${scale} physical records: ${kind} preserves population (${Date.now()-started}ms)`, true);
      }
      if (scale > 62001) {
        const storage = (await database.query('SELECT pg_total_relation_size($1::regclass)::text AS bytes', [`"${schema}"."Tickets"`])).rows[0].bytes;
        console.log(`Physical scale fixture: ${scale} rows, ${storage} bytes including indexes.`);
        const finalPage = await request('/api/graphs', { action: 'render', source: graphSource, spec: { ...config, kind: 'bar', dimension: member('TicketId'), offset: scale-50, pageSize: 50 } });
        assert.equal(finalPage.status, 200, JSON.stringify(finalPage.data));
        assert.equal(finalPage.data.total, scale); assert.equal(finalPage.data.rows.length, 50);
        const context = { model: parseModel(modelRows[0].confirmed_yaml), ownerUserId: userIds[0] };
        const largeSummary = await collectReportSummary(catalog, data.semanticQuery, (q) => workspaceCubeLoad(context, q, 'sql'), async (statement) => (await database.query(statement)).rows[0].result);
        const stats = largeSummary.numeric.find((f) => f.member === member('Amount')).statistics;
        assert.equal(largeSummary.population, String(scale));
        assert.equal(Number(stats.median), (scale+1)/2); assert.equal(Number(stats.average), (scale+1)/2);
        assert.equal(BigInt(stats.sum), BigInt(scale)*BigInt(scale+1)/2n);
        check(`${scale} physical records: last graph page and exact full-data summary`, true);
        if (process.env.TEST_SCALE_CHAT === '1') {
          const largeChat = await request('/api/chat', { message: 'List only TicketId, Amount, Status, CreatedAt and LinkId for every Tickets record.', workspaceId, history: [] });
          assert.equal(largeChat.status, 200, JSON.stringify(largeChat.data));
          assert.equal(largeChat.data.data?.semanticQueryTotalCount, scale);
          assert.equal(largeChat.data.data.semanticQueryTable.rows.length, 200);
          assert.ok(/average|median/i.test(largeChat.data.narrative));
          assert.ok(!/could not be calculated|wording is unavailable/i.test(largeChat.data.narrative));
          const largeReport = await request('/api/reports', { title: largeChat.data.title, narrative: largeChat.data.narrative, topic: largeChat.data.topic, chartType: 'none', data: largeChat.data.data, tablesUsed: largeChat.data.tablesUsed });
          assert.equal(largeReport.status, 200);
          const reopened = await request(`/api/reports/${largeReport.data.id}`);
          assert.equal(reopened.data.report.narrative, largeChat.data.narrative);
          const params = new URLSearchParams({ q: JSON.stringify(largeChat.data.data.semanticQuery), workspaceId, modelVersion: largeChat.data.data.warehouseQuery.modelVersion, page: String(Math.ceil(scale/100)), pageSize: '100' });
          const finalTablePage = await request(`/api/lists/semantic?${params}`);
          assert.equal(finalTablePage.status, 200, JSON.stringify(finalTablePage.data));
          assert.equal(finalTablePage.data.totalCount, scale); assert.equal(finalTablePage.data.table.rows.length, 100);
          check(`${scale} physical records: fresh AI insight, capped preview, saved report and final table page`, true);
        }
      }
      await database.query(`DELETE FROM "${schema}"."Tickets" WHERE "Amount">2001`);
    }
    if (process.env.TEST_GRAPH_UI === '1') {
      await request(`/api/reports/${saved.data.id}`, { chartSpec: null }, cookie, 'PATCH');
      console.log(`GRAPH_UI_READY email=warehouse-test-${suffix}-owner@example.invalid report=${base}/reports/${saved.data.id}`);
      await new Promise((resolve) => {
        const finish = () => { process.stdin.off('data', finish); process.stdin.pause(); process.off('SIGTERM', finish); process.off('SIGINT', finish); resolve(); };
        process.stdin.once('data', finish); process.once('SIGTERM', finish); process.once('SIGINT', finish);
      });
    }
  }
  const exportResponse = await fetch(`${base}/api/exports/report/semantic?${q}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(90000) });
  assert.equal(exportResponse.status, 200); const buffer = Buffer.from(await exportResponse.arrayBuffer());
  const XLSX = await import('xlsx'); const book = XLSX.read(buffer, { type: 'buffer' }); const sheet = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
  check('Excel exports all 2001 rows, not preview', sheet.length === 2002);
  const session = await request('/api/chat-sessions', { title: 'Warehouse session', workspaceId });
  const reopened = await request(`/api/chat-sessions/${session.data.id}`); check('conversation retains warehouse before first report', reopened.data.session.warehouse_id === workspaceId);
  const artifact = { title: full.title, narrative: full.narrative, topic: full.topic, chartType: 'none', data: full.data, days: 30, region: null, tablesUsed: full.tablesUsed };
  const historyMessage = await request('/api/chat-history', { sessionId: session.data.id, role: 'assistant', content: full.narrative, reportData: artifact });
  assert.equal(historyMessage.status, 200);
  assert.ok(Number.isSafeInteger(historyMessage.data.id));
  const chartSpec = { groups: [], reportGraph: { kind: 'bar', category: full.data.semanticQuery.dimensions[0], measure: '__count', page: 2, pageSize: 20 } };
  const linkedReport = await request('/api/reports', { ...artifact, sourceSessionId: session.data.id, chartSpec });
  assert.equal(linkedReport.status, 200);
  const historySave = await request('/api/chat-history', { messageId: historyMessage.data.id, reportId: linkedReport.data.id }, cookie, 'PATCH');
  assert.equal(historySave.status, 200, JSON.stringify(historySave.data));
  const restoredHistory = await request(`/api/chat-sessions/${session.data.id}`);
  assert.equal(restoredHistory.data.messages[0].report_data.savedReportId, linkedReport.data.id);
  assert.deepEqual(restoredHistory.data.messages[0].report_data.chartSpec, chartSpec);
  check('saved report and graph settings survive reopening chat', true);
  check('cross-owner chat report update denied', (await request('/api/chat-history', { messageId: historyMessage.data.id, reportId: linkedReport.data.id }, second, 'PATCH')).status === 404);
  const legacySession = await request('/api/chat-sessions', { title: 'Legacy test session' });
  check('existing conversation cannot switch warehouse', (await request('/api/chat', { message: 'Count Tickets', workspaceId, sessionId: legacySession.data.id })).status === 409);
  const invalid = await request(`/api/workspaces/${workspaceId}/warehouse`, { action: 'activate', selectedTables: [`${schema}.UserTokens`], approvedJoins: [], draftFingerprint: discovery.fingerprint });
  check('restricted activation rejected', invalid.status !== 200);
  check('failed update keeps active model', (await request(`/api/workspaces/${workspaceId}/warehouse`)).data.ready);
  }
  if (process.env.TEST_TICKETING === '1') {
    const raw = await request(`/api/workspaces/${workspaceId}/warehouse`, { action: 'discover', connectionString: url, schemas: ['raw_ticketing'] });
    assert.equal(raw.status, 200);
    const rawDiscovery = raw.data.discovery;
    const selected = ['Tk_TicketInfoMaster', 'Tk_TicketType', 'Tk_TicketStatus'].map((t) => `raw_ticketing.${t}`);
    const approved = rawDiscovery.candidates.filter((j) => j.from === selected[0] && selected.slice(1).includes(j.to)).map((j) => j.id);
    assert.equal(approved.length, 2);
    const activatedRaw = await request(`/api/workspaces/${workspaceId}/warehouse`, { action: 'activate', selectedTables: selected, approvedJoins: approved, draftFingerprint: rawDiscovery.fingerprint });
    assert.equal(activatedRaw.status, 200, JSON.stringify(activatedRaw.data));
    const [savedModel] = await app.execute('SELECT confirmed_yaml FROM workspace_semantic_models WHERE workspace_id=?', [workspaceId]);
    const rawModel = parseModel(savedModel[0].confirmed_yaml);
    const root = modelCatalog(rawModel).find((c) => c.table === selected[0]);
    const count = `${root.name}.record_count`;
    const field = (title) => root.dimensions.find((d) => d.title === title).name;
    // LOCAL ONLY: direct Cube queries, no real schema, counts, labels or
    // records are sent to any AI service by this optional live-data check.
    for (const [label, filters, sql] of [
      ['all tickets', [], 'SELECT count(*)::text AS n FROM raw_ticketing."Tk_TicketInfoMaster"'],
      ['fiber tickets', [{ member: field('TicketTypeID'), operator: 'equals', values: ['5'] }], 'SELECT count(*)::text AS n FROM raw_ticketing."Tk_TicketInfoMaster" WHERE "TicketTypeID"=5'],
      ['non-empty LinkId', [{ member: field('LinkId'), operator: 'set' }, { member: field('LinkId'), operator: 'notEquals', values: [''] }], 'SELECT count(*)::text AS n FROM raw_ticketing."Tk_TicketInfoMaster" WHERE "LinkId" IS NOT NULL AND "LinkId"<>\'\''],
    ]) {
      const expected = (await database.query(sql)).rows[0].n;
      const reply = await workspaceCubeLoad({ model: rawModel, ownerUserId: userIds[0] }, { measures: [count], filters });
      assert.equal(String(reply.data[0]?.[count]), expected, label);
      console.log(`PASS local-only real ticketing count: ${label} (${expected})`);
    }
  }
  console.log(process.exitCode ? 'Warehouse onboarding integration completed with failures; see the audit.' : 'Warehouse onboarding integration passed.');
} finally {
  const cleanup = await mysql.createConnection({ host: env.DB_APP_HOST, port: Number(env.DB_APP_PORT || 3306), database: env.DB_APP_NAME, user: env.DB_APP_USER, password: env.DB_APP_PASSWORD });
  try { for (const id of userIds) await cleanup.execute('DELETE FROM users WHERE id=? AND email LIKE ?', [id, `warehouse-test-${suffix}-%@example.invalid`]); }
  finally {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await database.end(); await cleanup.end(); await app.end().catch(() => {});
  }
}
