import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageTools } from './coverage.mjs';
import { compileTool } from './model.mjs';
import { recordGraphPlan } from './graph-plan.mjs';
const catalog = { objects: [{ id: 'tickets', schema: 'dbo', name: 'Tickets', kind: 'table', columns: [{ name: 'ID', dataType: 'int', isPrimaryKey: true }, { name: 'Category', dataType: 'varchar' }] }], relationships: [] };
for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
  test(`${dialect}: record graph preserves full-query filters and uses database grouping`, () => {
    const [rows, analytics] = coverageTools(catalog);
    const query = JSON.stringify({ columns: ['tickets:Category'], filters: [{ field: 'tickets:ID', operator: 'gt', parameter: 'id', required: true }], values: { id: 10 } });
    const plan = recordGraphPlan(rows, catalog, dialect, query, 'tickets:Category');
    const compiled = compileTool(analytics, catalog, dialect, { query: plan });
    assert.deepEqual(compiled.values, [10]);
    assert.match(compiled.populationSql, /GROUP BY/);
    assert.doesNotMatch(compiled.populationSql, /\bLIMIT\b|\bTOP\b|\bOFFSET\b/);
    assert.throws(() => recordGraphPlan(rows, catalog, dialect, query, 'tickets:ID'), /returned/);
    assert.throws(() => recordGraphPlan(rows, catalog, dialect, JSON.stringify({ sql: 'DELETE FROM Tickets' }), 'tickets:Category'));
  });
}
test('fixed approved tools accept bound values without permitting a replacement plan', () => {
  const [tool] = coverageTools(catalog);
  delete tool.capabilities;
  tool.filters = [{ field: 'tickets:ID', operator: 'eq', parameter: 'id', required: true }];
  const result = compileTool(tool, catalog, 'sqlserver', { query: JSON.stringify({ values: { id: 12 } }) });
  assert.deepEqual(result.values, [12]);
  assert.throws(() => compileTool(tool, catalog, 'sqlserver', { query: JSON.stringify({ columns: ['tickets:Category'], values: { id: 12 } }) }));
  assert.throws(() => compileTool(tool, catalog, 'sqlserver', { query: JSON.stringify({ values: { unknown: 12 } }) }));
});
