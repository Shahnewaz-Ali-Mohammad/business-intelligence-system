import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionsFor, coveredDepartments, validRoles } from './permissions.mjs';
import { scopeToolParameters, scopeProcedureValues, runWithAccess, scopeForQuery, AccessDenied, tablesUsed } from './data-scope.mjs';

const departments = [{ id: 1, name: 'Operations', parentId: null }, { id: 2, name: 'Billing', parentId: 1 }, { id: 3, name: 'Support', parentId: 1 }];
const tool = { base: 'dbo.Bills', mode: 'rows', columns: ['dbo.Bills:Amount'], groupBy: [], metrics: [], filters: [], capabilities: { fields: ['dbo.Bills:Amount', 'dbo.Bills:ZoneId', 'dbo.Bills:BillDate', 'dbo.Packages:Name'], joins: [] } };
const policy = { departmentField: 'dbo.Bills:ZoneId', departmentValues: { 2: ['5', '6'], 3: ['7'] }, tables: { 'dbo.Bills': 'department', 'dbo.Packages': 'shared', 'dbo.Salaries': 'restricted' } };
const manager = { roles: ['manager'], dataRole: true, allData: false, departmentIds: [2] };

test('roles grant permissions; the admin role alone sees no data', () => {
  assert.ok(permissionsFor(['ceo']).includes('data.all'));
  assert.ok(!permissionsFor(['admin']).includes('data.all'));
  assert.ok(!permissionsFor(['admin']).includes('chat.use'));
  assert.ok(!permissionsFor(['executive']).includes('reports.schedule'));
  assert.deepEqual(permissionsFor(['nonsense']), []);
  assert.ok(validRoles(['admin', 'manager']));
  assert.ok(!validRoles([]) && !validRoles(['owner']) && !validRoles(['ceo', 'ceo']));
});

test('managers cover departments below theirs; executives only their own', () => {
  assert.deepEqual(coveredDepartments([1], departments).sort(), [1, 2, 3]);
  assert.deepEqual(coveredDepartments([1], departments, false), [1]);
});

test('the CEO query runs unchanged', () => {
  const parameters = { query: '{"columns":"*"}' };
  assert.equal(scopeToolParameters({ definition: tool, parameters, access: { allData: true }, policy: null }), parameters);
});

test('a manager query gets their department filter, combined with their own filter', () => {
  const out = scopeToolParameters({ definition: tool, parameters: { query: JSON.stringify({ where: { field: 'dbo.Bills:Amount', operator: 'gt', value: 10 } }) }, access: manager, policy });
  assert.deepEqual(JSON.parse(out.query).where, { and: [{ field: 'dbo.Bills:Amount', operator: 'gt', value: 10 }, { field: 'dbo.Bills:ZoneId', operator: 'in', value: ['5', '6'] }] });
});

test('the department filter cannot be removed by the plan: it is always added', () => {
  const out = scopeToolParameters({ definition: tool, parameters: { query: JSON.stringify({ where: { or: [{ field: 'dbo.Bills:ZoneId', operator: 'eq', value: '7' }, { field: 'dbo.Bills:ZoneId', operator: 'not_null' }] } }) }, access: manager, policy });
  const where = JSON.parse(out.query).where;
  assert.deepEqual(where.and[1], { field: 'dbo.Bills:ZoneId', operator: 'in', value: ['5', '6'] });
});

test('shared tables are not filtered; restricted and unclassified tables are refused', () => {
  const packages = { ...tool, base: 'dbo.Packages', columns: ['dbo.Packages:Name'], capabilities: { fields: ['dbo.Packages:Name'], joins: [] } };
  const parameters = { query: '{"columns":"*"}' };
  assert.equal(scopeToolParameters({ definition: packages, parameters, access: manager, policy }), parameters);
  assert.throws(() => scopeToolParameters({ definition: { ...packages, base: 'dbo.Salaries' }, parameters, access: manager, policy }), AccessDenied);
  assert.throws(() => scopeToolParameters({ definition: { ...packages, base: 'dbo.Unknown' }, parameters, access: manager, policy }), /cannot view/);
});

test('people without a department, a policy or a data role see nothing', () => {
  const parameters = { query: '{}' };
  assert.throws(() => scopeToolParameters({ definition: tool, parameters, access: { ...manager, departmentIds: [] }, policy }), /assigned to your department/);
  assert.throws(() => scopeToolParameters({ definition: tool, parameters, access: manager, policy: null }), /not set up/);
  assert.throws(() => scopeToolParameters({ definition: tool, parameters, access: { roles: ['admin'], dataRole: false }, policy }), /does not include/);
});

test('a query reaching a restricted table through a joined field is refused', () => {
  const joined = { ...tool, capabilities: { fields: [...tool.capabilities.fields, 'dbo.Salaries:Amount'], joins: [] } };
  assert.deepEqual(tablesUsed(joined, { columns: ['dbo.Salaries:Amount'] }).sort(), ['dbo.Bills', 'dbo.Salaries']);
  assert.throws(() => scopeToolParameters({ definition: joined, parameters: { query: '{"columns":["dbo.Salaries:Amount"]}' }, access: manager, policy }), /Salaries/);
});

test('queries outside a signed-in scope are refused', async () => {
  await assert.rejects(scopeForQuery({ host: 'h', port: 1 }, tool, null, { query: '{}' }), /no signed-in user/);
  const out = await runWithAccess({ ...manager, policyFor: async () => policy }, () => scopeForQuery({ host: 'h', port: 1 }, tool, null, { query: '{}' }));
  assert.ok(JSON.parse(out.query).where);
});

test('stored procedures: CEO free, others only with a department parameter and one value', () => {
  const procedure = { id: 9 };
  assert.deepEqual(scopeProcedureValues({ procedure, values: { a: 1 }, access: { allData: true } }), { a: 1 });
  assert.throws(() => scopeProcedureValues({ procedure, values: {}, access: manager, policy }), /CEO only/);
  const withRule = { ...policy, procedures: { 9: { parameter: '@Zone' } } };
  assert.throws(() => scopeProcedureValues({ procedure, values: {}, access: manager, policy: withRule }), /several/);
  assert.deepEqual(scopeProcedureValues({ procedure, values: { '@Zone': '99' }, access: { ...manager, departmentIds: [3] }, policy: withRule }), { '@Zone': '7' });
});
