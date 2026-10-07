import test from 'node:test';
import assert from 'node:assert/strict';
import { graphOptions, defaultGraph, normalizeGraph, graphQuery, uncappedCubeSql, distributionSql } from './reportGraph.mjs';

const catalog = [{ name: 'Tickets', measures: [{ name: 'Tickets.count', title: 'Ticket count', type: 'count' }], dimensions: [{ name: 'Tickets.id', title: 'TicketID', type: 'string', primaryKey: true }, { name: 'Tickets.subject', title: 'Subject', type: 'string' }, { name: 'Tickets.amount', title: 'Amount', type: 'number' }, { name: 'Tickets.hours', title: 'Hours', type: 'number' }, { name: 'Tickets.created', title: 'Created', type: 'time' }], joins: [{ name: 'Status', relationship: 'many_to_one' }] }, { name: 'Status', measures: [], dimensions: [{ name: 'Status.name', title: 'Status name', type: 'string' }], joins: [] }];
const source = { dimensions: ['Tickets.id', 'Tickets.subject', 'Tickets.amount', 'Tickets.hours', 'Tickets.created', 'Status.name'], filters: [{ member: 'Tickets.subject', operator: 'contains', values: ['fiber'] }], timeDimensions: [{ dimension: 'Tickets.created', dateRange: ['2025-01-01', '2025-12-31'] }] };
const options = graphOptions(catalog, source);
test('one-column lists still have a frequency/count graph; identifiers are not numeric axes', () => {
  assert.equal(options.defaultMeasure, 'Tickets.count');
  assert.ok(options.kinds.includes('histogram'));
  assert.ok(options.categories.some((f) => f.name === 'Tickets.id'));
  assert.ok(!options.numerics.some((f) => f.name === 'Tickets.id'));
  assert.equal(defaultGraph(options, { measures: ['Tickets.count'] }).kind, 'kpi');
});
test('graph choices contain returned columns, not every joined field', () => {
  const scoped = graphOptions(catalog, { dimensions: ['Tickets.id', 'Tickets.subject', 'Tickets.amount'], filters: [{ member: 'Status.name', operator: 'equals', values: ['Open'] }], timeDimensions: [{ dimension: 'Tickets.created', dateRange: ['2025-01-01', '2025-12-31'] }], order: { 'Tickets.hours': 'desc' } });
  assert.deepEqual(scoped.categories.map((f) => f.name), ['Tickets.id', 'Tickets.subject']);
  assert.deepEqual(scoped.numerics.map((f) => f.name), ['Tickets.amount']);
  assert.deepEqual(scoped.times, []);
  assert.ok(!scoped.kinds.includes('scatter'));
  assert.ok(!scoped.kinds.includes('line'));
  assert.throws(() => normalizeGraph({ ...defaultGraph(scoped, source), dimension: 'Status.name' }, scoped), /category/);
  assert.throws(() => normalizeGraph({ ...defaultGraph(scoped, source), filters: [{ member: 'Status.name', operator: 'equals', values: ['Open'] }] }, scoped), /filter/);
  assert.equal(graphOptions(catalog, source).defaultCategory, 'Status.name');
  assert.equal(graphOptions(catalog, { dimensions: ['Tickets.subject'] }).defaultCategory, 'Tickets.subject');
});
test('one-column report does not gain unrelated numeric or date fields', () => {
  const scoped = graphOptions(catalog, { dimensions: ['Tickets.id'] });
  assert.deepEqual(scoped.kinds, ['kpi', 'bar']);
  assert.deepEqual(scoped.categories.map((f) => f.name), ['Tickets.id']); assert.deepEqual(scoped.times, []); assert.deepEqual(scoped.numerics, []);
  assert.match(scoped.measures[0].title, /computed/);
});
test('only selected measures and a computed record count are offered', () => {
  const extra = [{ ...catalog[0], measures: [...catalog[0].measures, { name: 'Tickets.sum', title: 'Total amount', type: 'sum' }] }, catalog[1]];
  assert.deepEqual(graphOptions(extra, { dimensions: ['Tickets.amount'] }).measures.map((m) => m.name), ['Tickets.count']);
  assert.deepEqual(graphOptions(extra, { measures: ['Tickets.sum'] }).measures.map((m) => m.name), ['Tickets.sum', 'Tickets.count']);
});
test('graph validation blocks invented members, joins, styles, offsets and filters', () => {
  const spec = defaultGraph(options, source);
  assert.throws(() => normalizeGraph({ ...spec, measure: 'Other.count' }, options), /approved/);
  assert.throws(() => normalizeGraph({ ...spec, kind: 'pie' }, options), /style/);
  assert.throws(() => normalizeGraph({ ...spec, offset: -1 }, options), /page/);
  assert.throws(() => normalizeGraph({ ...spec, filters: [{ member: 'Other.name', operator: 'equals', values: ['a'] }] }, options), /filter/);
  assert.throws(() => normalizeGraph({ ...spec, kind: 'scatter', x: 'Tickets.amount', y: 'Tickets.amount' }, options), /different/);
});
test('every graph retains original nested filters and date scope', () => {
  const spec = normalizeGraph({ ...defaultGraph(options, source), kind: 'line', time: 'Tickets.created', filters: [{ member: 'Status.name', operator: 'equals', values: ['Open'] }], granularity: 'day' }, options);
  const q = graphQuery(source, spec, options);
  assert.deepEqual(q.filters, [...source.filters, ...spec.filters]);
  assert.deepEqual(q.timeDimensions[0].dateRange, source.timeDimensions[0].dateRange);
  assert.equal(q.timeDimensions[0].granularity, 'day');
  assert.equal(q.limit, undefined);
});
test('aggregate thresholds keep their report grouping instead of changing the population', () => {
  const query = { measures: ['Tickets.count'], dimensions: ['Status.name'], filters: [{ member: 'Tickets.count', operator: 'gte', values: ['1001'] }] };
  const o = graphOptions(catalog, query);
  assert.equal(o.fixedGrouping, true);
  assert.deepEqual(o.kinds, ['bar']);
  const spec = normalizeGraph(defaultGraph(o, query), o);
  const graph = graphQuery(query, spec, o);
  assert.deepEqual(graph.dimensions, query.dimensions);
  assert.deepEqual(graph.filters, query.filters);
  assert.deepEqual(graph.measures, query.measures);
  assert.throws(() => normalizeGraph({ ...spec, kind: 'kpi' }, o), /style/);
});
test('uncapping parses only trusted outer SELECT; nested limits and parameters remain', () => {
  const c = uncappedCubeSql({ sql: { sql: ['SELECT v AS a,COUNT(*) AS n FROM (SELECT * FROM t LIMIT 9) q WHERE v > $1 GROUP BY v ORDER BY v LIMIT 50000', ['1']], aliasNameToMember: { a: 'Tickets.amount', n: 'Tickets.count' } } });
  assert.ok(!c.text.includes('50000'));
  assert.ok(c.text.includes('LIMIT (9)'));
  assert.deepEqual(c.values, ['1']);
  assert.throws(() => uncappedCubeSql({ sql: { sql: ['DELETE FROM t', []], aliasNameToMember: {} } }), /Unsupported/);
  assert.throws(() => uncappedCubeSql({ sql: { sql: ['SELECT 1;SELECT 2', []], aliasNameToMember: {} } }), /Unsupported/);
});
test('distribution bins use population weights and bounded output, not a row sample', () => {
  const c = { text: 'SELECT a,b,n FROM source', values: ['1'], aliases: { a: 'Tickets.amount', b: 'Tickets.hours', n: 'Tickets.count' } };
  const histogram = distributionSql(c, { kind: 'histogram', x: 'Tickets.amount' }, 'Tickets.count');
  assert.ok(histogram.text.includes('sum(weight)'));
  assert.ok(!histogram.text.includes('LIMIT'));
  const scatter = distributionSql(c, { kind: 'scatter', x: 'Tickets.amount', y: 'Tickets.hours' }, 'Tickets.count');
  assert.ok(scatter.text.includes('LIMIT 201'));
  assert.deepEqual(scatter.values, ['1']);
  assert.throws(() => distributionSql(c, { kind: 'histogram', x: 'Missing.number' }, 'Tickets.count'), /alias/);
});

test('graph paging is bounded and old saved searches no longer restrict results', () => {
  assert.equal(normalizeGraph(defaultGraph(options, source), options).pageSize, 50);
  for (const pageSize of [20, 50, 100]) {
    const spec = normalizeGraph({ ...defaultGraph(options, source), pageSize, offset: pageSize, search: 'old hidden search' }, options);
    assert.equal(spec.pageSize, pageSize);
    assert.equal(spec.offset, pageSize);
    assert.equal(spec.search, '');
    assert.deepEqual(graphQuery(source, spec, options).filters, source.filters);
  }
  assert.throws(() => normalizeGraph({ ...defaultGraph(options, source), pageSize: 500000 }, options), /page size/);
  assert.equal(normalizeGraph({ ...defaultGraph(options, source), offset: 4999999950 }, options).offset, 4999999950);
  assert.throws(() => normalizeGraph({ ...defaultGraph(options, source), offset: Number.MAX_SAFE_INTEGER }, options), /page/);
});

test('five returned columns are listed with table names and safe graph roles', () => {
  const c = [{ name: 'Orders', table: 'public.orders', measures: [{ name: 'Orders.count', type: 'count' }], dimensions: [
    { name: 'Orders.id', title: 'Order ID', type: 'number', primaryKey: true },
    { name: 'Orders.status', title: 'Status', type: 'string' },
    { name: 'Orders.amount', title: 'Amount', type: 'number' },
    { name: 'Orders.created', title: 'Created date', type: 'time' },
    { name: 'Orders.note', title: 'Note', type: 'string' },
  ] }];
  const o = graphOptions(c, { dimensions: c[0].dimensions.map((f) => f.name) });
  assert.equal(o.columns.length, 5);
  assert.ok(o.columns.every((f) => f.table === 'public.orders'));
  assert.equal(o.defaultCategory, 'Orders.status');
  assert.ok(o.categories.some((f) => f.name === 'Orders.id'));
  assert.ok(!o.numerics.some((f) => f.name === 'Orders.id'));
  for (const [kind, field, member] of [['bar', 'dimension', 'Orders.id'], ['bar', 'dimension', 'Orders.status'], ['bar', 'dimension', 'Orders.note'], ['line', 'time', 'Orders.created'], ['histogram', 'x', 'Orders.amount']]) {
    const spec = normalizeGraph({ ...defaultGraph(o, {}), kind, [field]: member }, o);
    assert.doesNotThrow(() => graphQuery({ dimensions: o.columns.map((f) => f.name) }, spec, o));
  }
});

test('every non-empty subset of nine columns offers only valid, scoped graph styles', (t) => {
  const dimensions = [
    ['id', 'string', true], ['status', 'string'], ['subject', 'string'],
    ['type', 'string'], ['link', 'string'], ['amount', 'number'],
    ['hours', 'number'], ['created', 'time'], ['resolved', 'time'],
  ].map(([name, type, primaryKey]) => ({ name: `Rows.${name}`, title: name, type, primaryKey }));
  const c = [{ name: 'Rows', table: 'qa.rows', measures: [{ name: 'Rows.count', type: 'count' }], dimensions, joins: [] }];
  let combinations = 0;
  for (let mask = 1; mask < 512; mask++) {
    const selected = dimensions.filter((_, index) => mask & (1 << index)).map((d) => d.name);
    const query = { dimensions: selected, filters: [{ member: 'Rows.status', operator: 'notEquals', values: ['Hidden'] }] };
    const options = graphOptions(c, query);
    assert.deepEqual(options.columns.map((d) => d.name).sort(), [...selected].sort());
    for (const kind of options.kinds) {
      const spec = normalizeGraph({ ...defaultGraph(options, query), kind }, options);
      if (['histogram', 'scatter', 'density'].includes(kind)) assert.ok(selected.includes(spec.x));
      if (['scatter', 'density'].includes(kind)) assert.ok(selected.includes(spec.y) && spec.x !== spec.y);
      const generated = graphQuery(query, spec, options);
      assert.deepEqual(generated.filters, query.filters);
      combinations++;
    }
    assert.throws(() => normalizeGraph({ ...defaultGraph(options, query), kind: 'kpi', measure: 'Foreign.count' }, options));
  }
  t.diagnostic(`Checked all 511 column subsets and ${combinations} supported subset/style combinations.`);
});
