import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { getWarehousePool } from '../../bi-warehouse/src/config/db.mjs';
import { CUBE_CATALOG, normalizeCubeQuery } from '../../bi-warehouse/src/semantic/cubeCatalog.mjs';
import { querySemanticLayerPage } from '../../bi-warehouse/src/services/cubeQueryService.mjs';
import { graphOptions, defaultGraph, normalizeGraph } from '../../bi-warehouse/src/semantic/reportGraph.mjs';

const pool = getWarehousePool();
const base = 'FROM public.fact_ticket f LEFT JOIN raw_ticketing."Tk_TicketInfoMaster" r ON r."SNID"=f.source_ticket_id';
const audit = [];
const appUrl = process.env.TEST_APP_URL || 'http://localhost:3000';
const email = `isp-chat-qa-${crypto.randomBytes(6).toString('hex')}@example.invalid`;
const password = crypto.randomBytes(20).toString('hex');
let cookie, userId, sessionId, uiReportId;
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${appUrl}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return { data, response };
}
const history = [{ role: 'user', content: 'Show tickets by link id.' }, { role: 'assistant', content: 'Please specify the link ID you are referring to for the ticket query.' }];
const cases = [
  ['screenshot null request', 'show me tickets whose link id is not null', 'r."LinkId" IS NOT NULL'],
  ['non-null after incorrect clarification', 'show me tickets whose link id is not null', 'r."LinkId" IS NOT NULL', history],
  ['populated links', 'List only source ticket ID and LinkId for tickets where LinkId is not null and LinkId is not empty.', 'r."LinkId" IS NOT NULL AND r."LinkId"<>\'\''],
  ['exact link', 'Show tickets whose LinkId equals 614110. Include only source ticket ID, LinkId and subject.', 'r."LinkId"=\'614110\''],
  ['leading-zero literal', 'Show tickets whose link ID equals 0614110. Preserve the leading zero.', 'r."LinkId"=\'0614110\''],
  ['missing link', 'Show tickets whose LinkId equals __LINK_DOES_NOT_EXIST__.', 'r."LinkId"=\'__LINK_DOES_NOT_EXIST__\''],
  ['null links', 'List only source ticket ID and LinkId where link ID is null.', 'r."LinkId" IS NULL'],
  ['empty links', 'List only source ticket ID and LinkId where link ID equals an empty string.', 'r."LinkId"=\'\''],
  ['OR links', 'Show tickets with LinkId 34097 OR LinkId 614110.', 'r."LinkId" IN (\'34097\',\'614110\')'],
  ['link exclusion', 'Show tickets with a populated LinkId, excluding LinkId 614110.', 'r."LinkId" IS NOT NULL AND r."LinkId"<>\'\' AND r."LinkId"<>\'614110\''],
  ['source field predicate', 'List source ticket ID, subject, priority and LinkId where LinkId equals 614110.', 'r."LinkId"=\'614110\''],
  ['source field grouping', 'Count tickets grouped by Priority.', null, [], 'IspTicket.priority'],
  ['screenshot grouping', 'Count tickets grouped by LinkId', null, history, 'IspTicket.link_id'],
  ['filtered grouping', 'Count tickets grouped by LinkId where LinkId is not null and not empty.', null, [], 'IspTicket.link_id', 'r."LinkId" IS NOT NULL AND r."LinkId"<>\'\''],
  ['all-ticket reset', 'Now show all tickets, with only source ticket ID and LinkId. Remove the previous LinkId filter.', 'TRUE', history],
  ['unknown field', 'Show tickets with the nonexistent field UnavailableSecretCustomCode. Do not substitute any field.', undefined],
];

try {
  const registration = await request('/api/auth/register', { email, password, displayName: 'ISP Chat QA' });
  userId = registration.data.user.id;
  cookie = registration.response.headers.get('set-cookie').split(';')[0];
  sessionId = (await request('/api/chat-sessions', { title: 'ISP ticket reply QA' })).data.id;
  const count = Number((await pool.query(`SELECT count(*) AS n ${base}`)).rows[0].n);
  assert.equal(count, Number((await pool.query('SELECT count(*) AS n FROM fact_ticket')).rows[0].n), 'Source enrichment changed ticket grain');
  const ticket = CUBE_CATALOG.find((c) => c.name === 'IspTicket');
  const all = await querySemanticLayerPage({ dimensions: ticket.dimensions.map((f) => f.name), filters: [{ member: 'IspTicket.link_id', operator: 'equals', values: ['614110'] }] }, { limit: 100 });
  assert.equal(all.total, 2);
  assert.equal(Object.keys(all.rows[0]).length, ticket.dimensions.length);
  assert.equal(all.rows[0]['IspTicket.link_id'], '614110');
  console.log(`PASS Cube executes all ${ticket.dimensions.length} ticket columns without multiplying ${count} tickets`);
  for (const [label, message, where, turns = [], grouping, groupedWhere = 'TRUE'] of cases) {
    const started = Date.now();
    try {
      const { data: result } = await request('/api/chat', { message, history: turns, sessionId });
      if (where === undefined) {
        assert.equal(result.askedClarification, true); assert.equal(result.data, null);
      } else {
        assert.notEqual(result.askedClarification, true, result.narrative);
        assert.ok(result.data?.semanticQuery, 'No executed semantic query');
        const q = normalizeCubeQuery(result.data.semanticQuery);
        if (grouping) {
          assert.ok(q.dimensions.includes(grouping), 'Missing requested grouping');
          assert.deepEqual(q.measures, ['IspTicket.ticket_count']);
          const column = grouping.endsWith('priority') ? 'Priority' : 'LinkId';
          const expected = (await pool.query(`SELECT r."${column}" AS label,count(*)::text AS n ${base} WHERE ${groupedWhere} GROUP BY r."${column}"`)).rows;
          const actual = await querySemanticLayerPage(q, { limit: 5000 });
          assert.equal(actual.total, expected.length);
          const canonical = (rows) => rows.map((r) => JSON.stringify(r)).sort();
          assert.deepEqual(canonical(actual.rows.map((r) => [r[grouping], String(r['IspTicket.ticket_count'])])), canonical(expected.map((r) => [r.label, r.n])));
        } else {
          const expected = Number((await pool.query(`SELECT count(*) AS n ${base} WHERE ${where}`)).rows[0].n);
          assert.equal(result.data.semanticQueryTotalCount, expected, result.narrative);
          assert.equal(q.measures.length, 0, 'A record list became an aggregate');
          assert.ok(q.dimensions.includes('IspTicket.link_id'), 'Requested LinkId absent from table');
        }
        assert.ok(result.title && result.title !== 'Query Results');
        assert.ok(!/specify.*(?:link|field)|averages.*unavailable|statistics.*could not/i.test(result.narrative), 'Premature clarification or failed summary');
        const saved = (await request('/api/reports', { ...result, sourceSessionId: sessionId })).data;
        assert.equal(saved.saved, true);
        const report = (await request(`/api/reports/${saved.id}`)).data.report;
        assert.equal(report.title, result.title);
        assert.equal(report.narrative, result.narrative);
        assert.deepEqual(report.data.semanticQuery, result.data.semanticQuery);
        const page = (await request(`/api/lists/semantic?${new URLSearchParams({ q: JSON.stringify(q), pageSize: '100' })}`)).data;
        assert.equal(page.totalCount, result.data.semanticQueryTotalCount);
        if (page.table.rows.length && page.totalCount > 0) assert.equal(page.table.headers.length, q.dimensions.length + q.measures.length);
        if (label === 'screenshot grouping' || label === 'populated links') {
          const options = graphOptions(CUBE_CATALOG, q);
          const spec = normalizeGraph({ ...defaultGraph(options, q), kind: 'bar', measure: 'IspTicket.ticket_count', dimension: 'IspTicket.link_id', title: 'Ticket count by LinkId' }, options);
          const graph = (await request('/api/graphs', { action: 'render', source: { query: q }, spec })).data;
          const expectedPopulation = grouping ? count : Number((await pool.query(`SELECT count(*) AS n ${base} WHERE ${where}`)).rows[0].n);
          assert.equal(graph.rows.reduce((sum, row) => sum + Number(row.value), 0), expectedPopulation);
          assert.ok(graph.options.categories.every((field) => q.dimensions.includes(field.name)), 'Graph offered a field absent from the report');
          const chartSpec = { groups: [], reportGraph: graph.spec };
          assert.equal((await request(`/api/reports/${saved.id}`, { chartSpec }, 'PATCH')).data.updated, true);
          assert.deepEqual((await request(`/api/reports/${saved.id}`)).data.report.chart_spec, chartSpec);
          uiReportId = saved.id;
        }
      }
      audit.push({ label, message, passed: true, milliseconds: Date.now() - started, query: result.data?.semanticQuery, total: result.data?.semanticQueryTotalCount });
      console.log(`PASS ${label}`);
    } catch (error) { audit.push({ label, message, passed: false, error: error.message }); console.error(`FAIL ${label}: ${error.message}`); process.exitCode = 1; }
    await writeFile('/private/tmp/bi-isp-ticket-chat-audit.json', JSON.stringify(audit, null, 2));
  }
} finally {
  await pool.end();
  if (userId && process.env.TEST_KEEP_UI === '1') {
    await writeFile('/private/tmp/bi-isp-ui-qa.json', JSON.stringify({ email, password, userId, sessionId, reportId: uiReportId }));
    console.log('Temporary UI QA account retained for browser verification; details in /private/tmp/bi-isp-ui-qa.json');
  } else if (userId) {
    const env = process.env;
    const app = await mysql.createConnection({ host: env.DB_APP_HOST, port: Number(env.DB_APP_PORT || 3306), database: env.DB_APP_NAME, user: env.DB_APP_USER, password: env.DB_APP_PASSWORD });
    try { await app.execute('DELETE FROM users WHERE id=? AND email=?', [userId, email]); }
    finally { await app.end(); }
  }
}
