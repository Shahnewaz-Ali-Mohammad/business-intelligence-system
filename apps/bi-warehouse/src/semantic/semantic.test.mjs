import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUBE_CATALOG, validateCubeQuery, normalizeCubeQuery, questionCatalogFields, simpleCatalogRequest } from './cubeCatalog.mjs';
import { buildChartQuery, chartOptions, chartQueryForTool, endOfBucket } from './chartQuery.mjs';
import { loadCubeQuery, querySemanticLayerPage, recordCountQuery } from '../services/cubeQueryService.mjs';
import { buildSemanticQueryTable } from '../../../bi-dashboard/scripts/lib/semantic-table.mjs';
import { parseToolResult } from '../../../bi-dashboard/scripts/lib/tool-result.mjs';
import { workspaceCubeLoad } from '../services/workspaceCube.mjs';
import { buildWarehouseModel, modelCatalog } from './warehouseModel.mjs';

test('live warehouse loads force fresh data; SQL compilation does not request execution', async () => {
  const originalFetch = globalThis.fetch, url = process.env.CUBEJS_API_URL, secret = process.env.CUBEJS_API_SECRET;
  process.env.CUBEJS_API_URL = 'http://cube.test';
  process.env.CUBEJS_API_SECRET = 'test-only';
  const model = buildWarehouseModel({ fingerprint: 'schema', connectionFingerprint: 'connection', tables: [{ key: 'example.Tickets', schema: 'example', name: 'Tickets', columns: [{ name: 'TicketId', dataType: 'integer', isPrimaryKey: true }] }], joins: [], candidates: [] }, '01234567-0123-4123-8123-012345678901', ['example.Tickets']);
  const query = { measures: [modelCatalog(model)[0].measures[0].name] };
  const calls = [];
  globalThis.fetch = async (endpoint, options) => { calls.push({ endpoint, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ data: [] }) }; };
  try {
    await workspaceCubeLoad({ model, ownerUserId: 1 }, query);
    await workspaceCubeLoad({ model, ownerUserId: 1 }, query, 'sql');
    await loadCubeQuery({ measures: ['IspTicket.ticket_count'] });
    assert.equal(calls[0].body.cache, 'no-cache');
    assert.equal(calls[1].body.cache, undefined);
    assert.equal(calls[2].body.cache, 'no-cache');
  } finally { globalThis.fetch = originalFetch; if (url === undefined) delete process.env.CUBEJS_API_URL; else process.env.CUBEJS_API_URL = url; if (secret === undefined) delete process.env.CUBEJS_API_SECRET; else process.env.CUBEJS_API_SECRET = secret; }
});

test('all business warehouse columns have a Cube dimension', () => {
  const sql = readFileSync(new URL('../../../../database/warehouse-schema.sql', import.meta.url), 'utf8');
  for (const cube of CUBE_CATALOG) {
    if (!cube.table) continue;
    const block = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${cube.table} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(block, cube.table);
    for (const line of block[1].split('\n')) {
      const column = line.trim().match(/^(\w+)\s+(?:VARCHAR|TEXT|TIMESTAMP|BIGSERIAL|BIGINT|SMALLINT|DATE|INT|NUMERIC)\b/i)?.[1];
      if (column) assert.ok(cube.dimensions.some((d) => d.name === `${cube.name}.${column}`), `Missing ${cube.table}.${column}`);
    }
  }
});

test('record IDs and transaction fields can be queried without measures', () => {
  for (const [cube, id] of [['IspTicket', 'source_ticket_id'], ['IspBilling', 'source_snid'], ['IspCustomer', 'customer_id'], ['IspRefund', 'refund_sk'], ['IspAdjustment', 'adjustment_sk'], ['IspCollection', 'collection_sk']]) {
    assert.doesNotThrow(() => validateCubeQuery({ dimensions: [`${cube}.${id}`], filters: [{ member: `${cube}.${id}`, operator: 'equals', values: ['000123'] }] }));
  }
  assert.throws(() => validateCubeQuery({ measures: ['IspBilling.fake_total'] }), /Unknown/);
  assert.throws(() => validateCubeQuery({ measures: ['IspBilling.amount'] }), /Not a measure/);
});

test('field planning repairs known dimension roles without inventing ambiguous members', () => {
  const q = normalizeCubeQuery({ measures: ['IspCustomer.customer_id', 'IspCustomer.customer_name'], filters: [{ dimension: 'IspCustomer.customer_id', operator: 'equals', values: ['000123'] }] });
  assert.deepEqual(q.measures, []);
  assert.deepEqual(q.dimensions, ['IspCustomer.customer_id', 'IspCustomer.customer_name']);
  assert.equal(q.filters[0].member, 'IspCustomer.customer_id');
  assert.throws(() => normalizeCubeQuery({ dimensions: ['customer_id'] }), /Ambiguous/);
});
test('field spelling resolves against the catalog, including camel case and spaced IDs', () => {
  for (const name of ['LinkId', 'link ID', 'link_id', 'IspTicket.LinkId']) {
    const q = normalizeCubeQuery({ dimensions: ['IspTicket.source_ticket_id', name], filters: [{ member: name, operator: 'set' }] });
    assert.equal(q.dimensions[1], 'IspTicket.link_id'); assert.equal(q.filters[0].member, 'IspTicket.link_id');
  }
  for (const question of ['Count tickets grouped by LinkId', 'show tickets whose link id is not null', 'LINKID equals 614110']) assert.ok(questionCatalogFields(question).includes('IspTicket.link_id'));
  assert.throws(() => normalizeCubeQuery({ dimensions: ['IspTicket.unavailable_column'] }), /Unknown|Ambiguous/);
});
test('ticket source enrichment preserves grain and explicitly models all source details', () => {
  const model = readFileSync(new URL('../../../../cube/model/isp.yml', import.meta.url), 'utf8');
  const ticket = CUBE_CATALOG.find((c) => c.name === 'IspTicket');
  assert.equal(ticket.dimensions.length, 50);
  assert.deepEqual(ticket.sourceTables, ['fact_ticket', 'raw_ticketing.Tk_TicketInfoMaster']);
  assert.match(model, /LEFT JOIN raw_ticketing\."Tk_TicketInfoMaster" r ON r\."SNID" = f\.source_ticket_id/);
  for (const field of ['link_id', 'subject', 'priority', 'ticket_no', 'assigned_to', 'is_reopen', 'status_change_date', 'follow_up_time']) assert.ok(ticket.dimensions.some((d) => d.name === `IspTicket.${field}`));
  assert.ok(!ticket.dimensions.some((d) => /password|secret|token/i.test(d.name)));
});
test('schema-driven simple requests cover every keyed catalog field without ignoring extra requirements', () => {
  let checked = 0;
  for (const cube of CUBE_CATALOG.filter((c) => c.dimensions.some((f) => f.primaryKey))) {
    const noun = cube.name.replace(/^Isp/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    for (const field of cube.dimensions) {
      const label = field.name.split('.').at(-1).replaceAll('_', ' ');
      for (const [text, operator] of [['is not null', 'set'], ['is null', 'notSet'], ...(field.type === 'string' ? [['equals __MISSING_001__', 'equals']] : [])]) {
        const planned = simpleCatalogRequest(`Show ${noun}s whose ${label} ${text}`);
        assert.equal(planned.query.filters[0].member, field.name);
        assert.equal(planned.query.filters[0].operator, operator);
        assert.equal(planned.query.dimensions.length, cube.dimensions.length);
        checked++;
      }
    }
  }
  for (const message of ['Show tickets whose link id equals 614110 and status equals 4', 'Show tickets whose link id equals 614110, only subject', 'Count tickets by LinkId where status equals 4', 'Show tickets whose unknown field is null']) assert.equal(simpleCatalogRequest(message), null);
  assert.equal(simpleCatalogRequest('Count tickets grouped by LinkId').query.dimensions[0], 'IspTicket.link_id');
  assert.equal(simpleCatalogRequest('Show tickets whose LinkId equals 0614110').query.filters[0].values[0], '0614110');
  console.log(`Checked ${checked} catalog-derived exact/null request plans.`);
});

test('nested filters, numeric comparisons, nulls and date ranges retain all constraints', () => {
  const source = { measures: ['IspBilling.total_billed'], filters: [{ or: [{ member: 'IspBilling.amount', operator: 'gte', values: ['200'] }, { member: 'IspBilling.tran_id', operator: 'notSet' }] }], timeDimensions: [{ dimension: 'IspBilling.ref_date', dateRange: ['2026-01-01', '2026-09-30'] }] };
  for (const kind of ['bar', 'line', 'heatmap']) {
    const q = buildChartQuery(source, { kind, dimension: 'IspCustomer.pop_id', time: 'IspBilling.ref_date', granularity: 'week' }, [{ member: 'IspCustomer.customer_id', operator: 'equals', values: ['X'] }]);
    assert.deepEqual(q.filters[0], source.filters[0]);
    assert.equal(q.filters[1].values[0], 'X');
    assert.deepEqual(q.timeDimensions[0].dateRange, source.timeDimensions[0].dateRange);
    assert.equal(q.measures[0], 'IspBilling.total_billed');
  }
});

test('graphs use database aggregation, never a loaded-row limit', () => {
  const source = chartQueryForTool('get_ticket_list', { status: 'open', dateFrom: '2026-01-01', limit: 200 });
  assert.equal(source.limit, undefined);
  assert.equal(source.measures[0], 'IspTicket.ticket_count');
  assert.equal(source.filters[0].values[0], 'open');
  assert.equal(chartOptions(source).defaultTime, 'IspTicket.opened_date');
  assert.equal(chartQueryForTool('get_active_customer_count').measures[0], 'IspCustomer.active_customer_count');
});

test('date zoom boundaries are exact, including leap day and quarters', () => {
  assert.equal(endOfBucket('2024-02-01T00:00:00.000', 'month'), '2024-02-29T23:59:59.999Z');
  assert.equal(endOfBucket('2026-01-01T00:00:00.000', 'quarter'), '2026-03-31T23:59:59.999Z');
});

test('semantic table preserves leading zeros and large record IDs', () => {
  const table = buildSemanticQueryTable([{ 'IspCustomer.customer_id': '000123', 'IspBilling.source_snid': '9007199254740993', 'IspBilling.total_billed': '123.5' }]);
  assert.deepEqual(table.rows[0], ['000123', '9007199254740993', 123.5]);
});

test('fast-path tool results unwrap MCP text blocks before reading numbers', () => {
  const payload = { totalBilled: 123.5, totalCollected: 50 };
  const content = [{ type: 'text', text: JSON.stringify(payload) }];
  for (const result of [JSON.stringify(payload), content, JSON.stringify(content), { content }, { structuredContent: payload, content }]) assert.deepEqual(parseToolResult(result), payload);
});

test('Cube transport retries Continue wait, coalesces requests and pages large totals', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.CUBEJS_API_URL;
  const originalSecret = process.env.CUBEJS_API_SECRET;
  process.env.CUBEJS_API_URL = 'http://cube.test';
  process.env.CUBEJS_API_SECRET = 'test-only';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.method, 'POST');
    const query = JSON.parse(init.body).query;
    if (calls === 1) return { ok: true, json: async () => ({ error: 'Continue wait' }) };
    return { ok: true, json: async () => ({ data: [{ 'IspBilling.total_billed': '10' }], total: 500000000, query }) };
  };
  try {
    const query = { measures: ['IspBilling.total_billed'] };
    const [a, b] = await Promise.all([loadCubeQuery(query), loadCubeQuery(query)]);
    assert.equal(calls, 2);
    assert.deepEqual(a, b);
    const page = await querySemanticLayerPage(query, { offset: 200, limit: 20 });
    assert.equal(page.total, 500000000);
    const ranked = await querySemanticLayerPage(query, { offset: 0, limit: 20, maxRows: 25 });
    assert.equal(ranked.total, 25);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl == null) delete process.env.CUBEJS_API_URL; else process.env.CUBEJS_API_URL = originalUrl;
    if (originalSecret == null) delete process.env.CUBEJS_API_SECRET; else process.env.CUBEJS_API_SECRET = originalSecret;
  }
});

test('record counts avoid wide grouping and preserve the full filter scope', () => {
  const query = { dimensions: ['IspTicket.ticket_sk', 'IspTicket.source_ticket_id'], filters: [{ member: 'IspTicket.ticket_type_id', operator: 'equals', values: ['5'] }], timeDimensions: [{ dimension: 'IspTicket.opened_date', dateRange: ['2025-01-01', '2025-01-31'] }] };
  assert.deepEqual(recordCountQuery(query), { measures: ['IspTicket.ticket_count'], filters: query.filters, timeDimensions: query.timeDimensions });
  assert.equal(recordCountQuery({ dimensions: ['IspTicket.status'] }), null);
  assert.equal(recordCountQuery({ dimensions: ['IspTicket.ticket_sk', 'IspCustomer.customer_name'] }), null);
  assert.equal(recordCountQuery({ ...query, measures: ['IspTicket.ticket_count'] }), null);
});

test('record pagination distinguishes an actual zero count from missing count data', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.CUBEJS_API_URL;
  const originalSecret = process.env.CUBEJS_API_SECRET;
  process.env.CUBEJS_API_URL = 'http://cube.test';
  process.env.CUBEJS_API_SECRET = 'test-only';
  let count = '41500';
  globalThis.fetch = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    return { ok: true, json: async () => ({ data: q.measures?.length ? count == null ? [] : [{ 'IspTicket.ticket_count': count }] : [] }) };
  };
  try {
    const q = { dimensions: ['IspTicket.ticket_sk'] };
    assert.equal((await querySemanticLayerPage(q)).total, 41500);
    count = '0';
    assert.equal((await querySemanticLayerPage(q)).total, 0);
    count = null;
    await assert.rejects(() => querySemanticLayerPage(q), /valid record count/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl == null) delete process.env.CUBEJS_API_URL; else process.env.CUBEJS_API_URL = originalUrl;
    if (originalSecret == null) delete process.env.CUBEJS_API_SECRET; else process.env.CUBEJS_API_SECRET = originalSecret;
  }
});
