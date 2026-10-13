import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageTools } from './coverage.mjs';
import { requiresDetailedReport, checkReportPlan, toolContext, candidateTools } from './chat-planning.mjs';
import { callWorkspaceMcp } from './chat-mcp.mjs';
const catalog = { objects: [{ id: 'customers', name: 'CustomerMaster', schema: 'dbo', kind: 'table', columns: [{name: 'CustomerID', dataType: 'int', isPrimaryKey: true}, {name: 'Name', dataType: 'varchar'}] }], relationships: [] };
const definitions = coverageTools(catalog);
const tools = definitions.map((definition, i) => ({ id: String(i), sourceId: 'customer-db', status: 'approved', definition }));
test('customer report is detail; explicit counts and summaries remain aggregates', () => {
  assert.equal(requiresDetailedReport('give me customer report'), true);
  assert.equal(requiresDetailedReport('customer count report'), false);
  assert.equal(requiresDetailedReport('billing totals by customer'), false);
});
test('a count alone cannot be published as a detailed customer report', () => {
  assert.throws(() => checkReportPlan({ message: 'give me customer report', definition: definitions[1], catalog, dialect: 'sqlserver', query: '{}' }), /count alone/);
  checkReportPlan({ message: 'give me customer report', definition: definitions[0], catalog, dialect: 'sqlserver', query: '{}' });
});
test('omitted requested fields are rejected; complete details pass', () => {
 assert.throws(() => checkReportPlan({ message: 'list names', definition: definitions[0], catalog, dialect: 'mysql', query: '{"columns":["customers:CustomerID"]}', requiredFields: ['customers:Name'] }), /omits requested/);
 checkReportPlan({ message: 'list names', definition: definitions[0], catalog, dialect: 'mysql', query: '{"columns":["customers:Name"]}', requiredFields: ['customers:Name'] });
});
test('selection receives actual field types and tool mode', () => {
 const context = toolContext(tools[0], catalog);
 assert.equal(context.mode, 'rows'); assert.equal(context.fields[1].id, 'customers:Name');
});
test('chat sends its request through MCP tools/list and tools/call', async () => {
 let calls = 0;
 const result = await callWorkspaceMcp(tools, tools[0], { query: '{}' }, async (selected, args) => {
  calls++; assert.equal(selected.sourceId, 'customer-db'); assert.equal(args.query, '{}');
  return { rows: [{ Name: 'Example' }], hasMore: false };
 });
 assert.equal(calls, 1); assert.equal(result.rows[0].Name, 'Example');
});
test('MCP cannot call a revoked tool', async () => {
 await assert.rejects(callWorkspaceMcp([{...tools[0], status:'draft'}], tools[0], {query:'{}'}, async () => {throw Error('Should never execute');}), /not approved/);
});
test('fixed business reports bind parameters through their published MCP schema', async () => {
 const fixed = {...tools[0], definition: {...definitions[0], capabilities: undefined, filters: [{field:'customers:CustomerID',operator:'eq',parameter:'id',required:true}]}};
 await callWorkspaceMcp([fixed], fixed, {query: '{"values":{"id":17}}'}, async (_selected,args) => {assert.deepEqual(args,{id:17});return {rows:[]};});
});

test('AI business output schema has no optional capabilities rejected by strict structured output', async () => {
 const {z} = await import('zod');
 const {BusinessDraftSchema} = await import('./model.mjs');
 const schema = z.toJSONSchema(BusinessDraftSchema);
 const tool = schema.properties.tools.items;
 assert.equal(tool.properties.capabilities, undefined);
 assert.deepEqual(new Set(tool.required), new Set(Object.keys(tool.properties)));
});

test('explicit customer counts cannot select a row tool; global totals exclude fixed grouped reports', () => {
 assert.ok(candidateTools('how many customers are there?', tools).every(t => t.definition.mode === 'aggregate'));
 const grouped = {...tools[1], definition:{...definitions[1],capabilities:undefined,groupBy:['customers:Name']}};
 assert.equal(candidateTools('total billed amount',[grouped]).length,0);
 assert.equal(candidateTools('billing totals by customer',[grouped]).length,1);
});
