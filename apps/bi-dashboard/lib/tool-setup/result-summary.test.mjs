import test from "node:test";
import assert from "node:assert/strict";
import { compileTool } from "./model.mjs";
import { coverageTools } from "./coverage.mjs";
import { summaryQuery, isSummaryMeasure, groupingCoverageQuery, detailMedianMeasures } from "./result-summary.mjs";
const catalog = {
  objects: [
    {
      id: "t",
      schema: "dbo",
      name: "T",
      kind: "table",
      columns: [
        { name: "Id", dataType: "int", isPrimaryKey: true },
        { name: "Amount", dataType: "decimal" },
      ],
    },
  ],
  relationships: [],
};
test('detail summaries avoid optional massive median sorts without using preview estimates', () => {
  const measures = [0, 1, 2, 3, 4];
  assert.deepEqual(detailMedianMeasures(100000, measures), [0, 1, 2, 3]);
  assert.deepEqual(detailMedianMeasures(12483367, measures), []);
  assert.deepEqual(detailMedianMeasures(NaN, measures), []);
  assert.deepEqual(measures, [0, 1, 2, 3, 4]);
});
test('numeric grouping codes never become measures in aggregate insights', () => {
  assert.equal(isSummaryMeasure('t:OfficeCat', { name: 'OfficeCat', dataType: 'int' }, 'aggregate'), false);
  assert.equal(isSummaryMeasure('office_count', undefined, 'aggregate'), true);
  assert.equal(isSummaryMeasure('t:Amount', { name: 'Amount', dataType: 'decimal' }, 'rows'), true);
  assert.equal(isSummaryMeasure('t:CustomerID', { name: 'CustomerID', dataType: 'int' }, 'rows'), false);
  for (const name of ['AssignedTo', 'AssignedBy', 'ForwardedBy', 'ForwardedTeam', 'LastActivityBy']) {
    assert.equal(isSummaryMeasure(`t:${name}`, { name, dataType: 'int' }, 'rows'), false);
  }
});
test('group completeness uses uncapped population SQL and type-safe null/empty checks', () => {
  for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
    const compiled = { populationSql: 'SELECT category AS c0 FROM existing_records' };
    const sql = groupingCoverageQuery(compiled, dialect, 0, true);
    assert.match(sql, /IS NULL/);
    assert.match(sql, /= ''/);
    assert.match(sql, /missing_groups/);
    assert.match(sql, /empty_groups/);
    assert.doesNotMatch(sql, /LIMIT|OFFSET|TOP/);
    assert.doesNotMatch(groupingCoverageQuery(compiled, dialect, 0), /= ''/);
  }
});
test("population summaries never inherit preview limits or offsets", () => {
  for (const dialect of ["postgres", "mysql", "sqlserver"]) {
    const compiled = compileTool(
      coverageTools(catalog)[0],
      catalog,
      dialect,
      {},
      100,
      100,
    );
    assert.doesNotMatch(compiled.populationSql, /TOP|LIMIT|OFFSET/);
    assert.match(compiled.sql, /OFFSET 100/);
    assert.match(summaryQuery(compiled, dialect), /population/);
    assert.match(summaryQuery(compiled, dialect, 1), /ROW_NUMBER/);
    assert.match(summaryQuery(compiled, dialect, 1), /median/);
  }
});
test("unsafe pagination offsets are rejected", () => {
  assert.throws(
    () =>
      compileTool(coverageTools(catalog)[0], catalog, "postgres", {}, 100, -1),
    /offset/,
  );
});
