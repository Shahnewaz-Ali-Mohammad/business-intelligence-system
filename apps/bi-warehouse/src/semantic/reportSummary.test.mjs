import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryPlan, summarySql, collectReportSummary } from './reportSummary.mjs';
import { distributionSql } from './reportGraph.mjs';

const catalog = [{ name: 'Records', table: 'records', measures: [{ name: 'Records.count', type: 'count' }, { name: 'Records.total', type: 'sum' }, { name: 'Records.rate', type: 'number' }], dimensions: [{ name: 'Records.id', type: 'number', primaryKey: true }, { name: 'Records.amount', type: 'number' }, { name: 'Records.status', type: 'string' }, { name: 'Records.date', type: 'time' }] }];
const query = { dimensions: ['Records.id', 'Records.amount', 'Records.status', 'Records.date'], filters: [{ member: 'Records.amount', operator: 'gt', values: ['1'] }], limit: 20 };

test('record statistics exclude identifiers and keep filters and row-count weights', () => {
  const p = summaryPlan(catalog, query);
  assert.deepEqual(p.numeric.map((f) => f.name), ['Records.amount']);
  assert.equal(p.count, 'Records.count');
  assert.deepEqual(p.query.filters, query.filters);
  assert.deepEqual(p.query.dimensions, query.dimensions.filter((f) => f !== 'Records.id'));
});
test('group statistics preserve HAVING scope and do not sum non-additive rates', () => {
  const q = { measures: ['Records.total', 'Records.rate'], dimensions: ['Records.status'], filters: [{ member: 'Records.total', operator: 'gt', values: ['100'] }] };
  const p = summaryPlan(catalog, q);
  assert.equal(p.count, null);
  assert.deepEqual(p.query, { ...q, order: {} });
  assert.deepEqual(p.numeric.map((f) => f.additive), [true, false]);
});
test('compiled SQL removes preview limits but preserves filters and parameters', async () => {
  const p = summaryPlan(catalog, query);
  const body = { sql: { sql: ['SELECT a,n,s,d FROM facts WHERE a>$1 LIMIT 20', ['1']], aliasNameToMember: { a: 'Records.amount', n: 'Records.count', s: 'Records.status', d: 'Records.date' } } };
  const statement = summarySql(body, p);
  assert.deepEqual(statement.values, ['1']);
  assert.ok(!statement.text.includes('LIMIT (20)'));
  assert.ok(statement.text.includes("'median'"));
  assert.ok(statement.text.includes('ceil(n/2)'));
  assert.ok(statement.text.includes("'missing'"));
  const result = await collectReportSummary(catalog, query, async (q) => { assert.deepEqual(q.filters, query.filters); return body; }, async () => ({ population: '1000' }));
  assert.equal(result.population, '1000'); assert.equal(result.rankingLimit, 20); assert.equal(result.approximation, false);
});

test('PostgreSQL computes exact weighted medians, null coverage, and full-group facts', { skip: process.env.TEST_SUMMARY_DB !== '1' }, async () => {
  const { getWarehousePool } = await import('../config/db.mjs');
  const pool = getWarehousePool();
  try {
    const p = summaryPlan(catalog, query);
    const body = { sql: { sql: ["SELECT * FROM (VALUES (1::numeric,1,'Open','2025-01-01'::date),(9,3,'Open','2025-01-02'::date),(NULL,2,'Closed','2025-01-03'::date),(-2,2,NULL,'2025-01-04'::date),(0,1,'Closed','2025-01-05'::date)) AS t(a,n,s,d) LIMIT 2", []], aliasNameToMember: { a: 'Records.amount', n: 'Records.count', s: 'Records.status', d: 'Records.date' } } };
    const result = (await pool.query(summarySql(body, p))).rows[0].result;
    assert.equal(result.population, '9');
    const s = result.numeric[0].statistics;
    assert.equal(s.count, '7'); assert.equal(s.missing, '2'); assert.equal(Number(s.median), 1); assert.equal(Number(s.minimum), -2); assert.equal(Number(s.maximum), 9);
    assert.ok(Math.abs(Number(s.average) - 24 / 7) < 1e-10);
    assert.equal(s.sum, '24'); assert.equal(s.zeroCount, '1'); assert.equal(s.negativeCount, '2');
    assert.equal(result.categories[0].breakdown.highest[0].label, 'Open');
    assert.equal(result.categories[0].breakdown.highest[0].percentage, '44.44');
    assert.equal(result.dates[0].earliest, '2025-01-01'); assert.equal(result.dates[0].latest, '2025-01-05');
    const grouped = summaryPlan(catalog, { measures: ['Records.total'], dimensions: ['Records.status'] });
    const groupedBody = { sql: { sql: ["SELECT * FROM (VALUES (10::numeric,'Open'),(30,'Closed'),(20,'Pending')) AS t(a,s) LIMIT 1", []], aliasNameToMember: { a: 'Records.total', s: 'Records.status' } } };
    const groupResult = (await pool.query(summarySql(groupedBody, grouped))).rows[0].result;
    assert.equal(groupResult.population, '3');
    assert.equal(Number(groupResult.numeric[0].statistics.median), 20);
    assert.equal(groupResult.numeric[0].highestGroups[0].labels['Records.status'], 'Closed');
    assert.equal(groupResult.numeric[0].highestGroups[0].percentageOfMetricTotal, '50.00');
    const tiedBody = { sql: { sql: ["SELECT * FROM (VALUES (30::numeric,'A'),(30,'B'),(30,'C'),(30,'D'),(10,'E')) AS t(a,s)", []], aliasNameToMember: { a: 'Records.total', s: 'Records.status' } } };
    const tiedResult = (await pool.query(summarySql(tiedBody, grouped))).rows[0].result;
    assert.equal(tiedResult.numeric[0].highestGroups.length, 3);
    assert.equal(tiedResult.numeric[0].highestGroups[0].tiedGroupCount, '4');
    assert.deepEqual(groupResult.categories, []);
    assert.equal(groupResult.numeric[0].lowestGroups[0].labels['Records.status'], 'Open');
    for (const [rows, median] of [['(1::numeric,1),(9,1)', 5], ['(42::numeric,1)', 42], ['(NULL::numeric,1)', null]]) {
      const single = { ...p, categories: [], dates: [] };
      const data = { sql: { sql: [`SELECT * FROM (VALUES ${rows}) AS t(a,n)`, []], aliasNameToMember: { a: 'Records.amount', n: 'Records.count' } } };
      const v = (await pool.query(summarySql(data, single))).rows[0].result.numeric[0].statistics;
      assert.equal(v.median == null ? null : Number(v.median), median);
      if (median == null) { assert.equal(v.average, null); assert.equal(v.standardDeviation, null); }
    }
    const weightedPlan = { ...p, categories: [], dates: [] };
    const billions = { sql: { sql: ['SELECT i::numeric AS a,100000000::numeric AS n FROM generate_series(1,50) i', []], aliasNameToMember: { a: 'Records.amount', n: 'Records.count' } } };
    const billionSummary = (await pool.query(summarySql(billions, weightedPlan))).rows[0].result;
    assert.equal(billionSummary.population, '5000000000');
    assert.equal(Number(billionSummary.numeric[0].statistics.median), 25.5);
    assert.equal(Number(billionSummary.numeric[0].statistics.average), 25.5);
    assert.equal(billionSummary.numeric[0].statistics.sum, '127500000000');
    for (const kind of ['histogram', 'scatter', 'density']) {
      const compiled = { text: 'SELECT i::numeric AS a,(i%50)::numeric AS b,10000000::numeric AS n FROM generate_series(1,500) i', values: [], aliases: { a: 'Records.amount', b: 'Records.hours', n: 'Records.count' } };
      const result = (await pool.query(distributionSql(compiled, { kind, x: 'Records.amount', y: 'Records.hours' }, 'Records.count'))).rows[0].result;
      assert.equal(result.population, '5000000000');
      assert.equal(result.included, '5000000000');
      assert.equal(result.rows.reduce((total, row) => total + BigInt(row.value), 0n), 5000000000n);
      assert.ok(result.rows.length <= 400);
    }
    for (const [rows, kind, population, included] of [
      ['(NULL::numeric,NULL::numeric,2),(-5,NULL,3),(0,2,5),(5,2,7)', 'histogram', '17', '15'],
      ['(NULL::numeric,NULL::numeric,2),(-5,NULL,3),(0,2,5),(5,2,7)', 'scatter', '17', '12'],
      ['(NULL::numeric,NULL::numeric,2)', 'density', '2', '0'],
    ]) {
      const compiled = { text: `SELECT * FROM (VALUES ${rows}) AS t(a,b,n)`, values: [], aliases: { a: 'Records.amount', b: 'Records.hours', n: 'Records.count' } };
      const result = (await pool.query(distributionSql(compiled, { kind, x: 'Records.amount', y: 'Records.hours' }, 'Records.count'))).rows[0].result;
      assert.equal(result.population, population); assert.equal(result.included, included);
      assert.equal(result.rows.reduce((total, row) => total+BigInt(row.value),0n), BigInt(included));
    }
  } finally { await pool.end(); }
});
