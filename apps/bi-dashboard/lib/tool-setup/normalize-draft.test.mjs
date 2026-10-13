import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFilterParameters } from './normalize-draft.mjs';
import { compileTool, ToolSchema } from './model.mjs';

const catalog = { objects: [{ id: 'tickets', schema: 'dbo', name: 'Tickets', kind: 'table', columns: [{name: 'Opened', dataType: 'datetime'}] }], relationships: [] };
const tool = { name: 'ticket_range', description: 'Tickets within the requested date range', base: 'tickets', joins: [], mode: 'rows', columns: ['tickets:Opened'], groupBy: [], metrics: [], filters: ['gte', 'lte'].map(operator => ({field: 'tickets:Opened', operator, parameter: 'date', required: true})) };
test('duplicate date parameters become independently bound inputs in all dialects', () => {
  const repaired = normalizeFilterParameters(tool);
  assert.deepEqual(repaired.filters.map(f => f.parameter), ['date', 'date_2']);
  assert.equal(tool.filters[1].parameter, 'date');
  for (const dialect of ['postgres', 'mysql', 'sqlserver']) {
    const compiled = compileTool(repaired, catalog, dialect, {date: '2026-01-01', date_2: '2026-02-01'});
    assert.deepEqual(compiled.values, ['2026-01-01', '2026-02-01']);
    assert.match(compiled.sql, />=/);
    assert.match(compiled.sql, /<=/);
  }
});
test('existing suffix names are preserved and long names remain valid', () => {
  const input = {...tool, filters: ['date', 'date', 'date_2', 'date'].map(parameter => ({...tool.filters[0], parameter}))};
  assert.deepEqual(normalizeFilterParameters(input).filters.map(f => f.parameter), ['date', 'date_3', 'date_2', 'date_4']);
  const long = {...tool, filters: tool.filters.map(f => ({...f, parameter: 'a'.repeat(63)}))};
  ToolSchema.parse(normalizeFilterParameters(long));
});
test('unique filters and fixed null predicates retain their meaning', () => {
  const input = {...tool, filters: [{...tool.filters[0], operator: 'not_null', required: false}, tool.filters[1]]};
  const output = normalizeFilterParameters(input);
  assert.equal(output.filters[0].operator, 'not_null');
  assert.equal(output.filters[0].required, false);
  assert.deepEqual(normalizeFilterParameters(output), output);
});
