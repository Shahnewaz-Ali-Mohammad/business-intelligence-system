import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionsFor, coveredDepartments, validRoles } from './permissions.mjs';
import { runWithAccess, scopeForQuery } from './data-scope.mjs';

const departments = [{ id: 1, name: 'Operations', parentId: null }, { id: 2, name: 'Billing', parentId: 1 }, { id: 3, name: 'Support', parentId: 1 }];

test('roles grant permissions; the admin role alone sees no data', () => {
  assert.ok(permissionsFor(['ceo']).includes('data.all'));
  assert.ok(!permissionsFor(['admin']).includes('data.all'));
  assert.ok(!permissionsFor(['admin']).includes('chat.use'));
  assert.ok(!permissionsFor(['executive']).includes('reports.schedule'));
  assert.ok(!permissionsFor(['executive']).includes('procedures.run'));
  assert.ok(permissionsFor(['manager']).includes('procedures.run'));
  assert.deepEqual(permissionsFor(['nonsense']), []);
  assert.ok(validRoles(['admin', 'manager']));
  assert.ok(!validRoles([]) && !validRoles(['owner']) && !validRoles(['ceo', 'ceo']));
});

test('managers cover departments below theirs; executives only their own', () => {
  assert.deepEqual(coveredDepartments([1], departments).sort(), [1, 2, 3]);
  assert.deepEqual(coveredDepartments([1], departments, false), [1]);
});

test('queries need a signed-in person with a data role', async () => {
  await assert.rejects(scopeForQuery({}, {}, null, { query: '{}' }), /no signed-in user/);
  await assert.rejects(runWithAccess({ dataRole: false }, () => scopeForQuery({}, {}, null, {})), /does not include/);
  const parameters = { query: '{"columns":"*"}' };
  assert.equal(await runWithAccess({ dataRole: true }, () => scopeForQuery({}, {}, null, parameters)), parameters);
  assert.equal(await runWithAccess({ setupPreview: true }, () => scopeForQuery({}, {}, null, parameters)), parameters);
});
