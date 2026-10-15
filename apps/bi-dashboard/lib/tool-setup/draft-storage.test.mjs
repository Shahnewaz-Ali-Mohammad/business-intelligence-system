import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDraftDefinitions, behaviourFingerprint } from './draft-storage.mjs';

function fakeConnection(rows) {
  const calls = [];
  return {
    calls,
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT catalog_fingerprint')) return [[{ catalog_fingerprint: 'fp' }]];
      if (sql.startsWith('SELECT id,name,status')) return [rows];
      return [{ affectedRows: 1 }];
    },
  };
}
const tool = (name, base = 'dbo.Tickets', description = 'Lists ticket rows for review.') => ({ name, description, base, joins: [], mode: 'rows', columns: [`${base}:Id`], groupBy: [], metrics: [], filters: [] });
const row = (id, definition, status = 'draft') => ({ id, name: definition.name, status, definition_json: JSON.stringify(definition), catalog_fingerprint: 'fp' });

test('same behaviour under a new name is not saved again', async () => {
  const connection = fakeConnection([row('a', tool('ticket_list'))]);
  const counts = await saveDraftDefinitions(connection, 's', 'fp', [tool('tickets_overview', 'dbo.Tickets', 'Different wording, same data.')]);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 1, removed: 0 });
  assert.ok(!connection.calls.some((c) => c.sql.startsWith('INSERT INTO bi_generated_tools')));
});

test('regenerating removes earlier drafts that were not produced again, never approved tools', async () => {
  const connection = fakeConnection([row('old', tool('old_draft', 'dbo.Old')), row('kept', tool('approved_tool', 'dbo.Kept'), 'approved')]);
  const counts = await saveDraftDefinitions(connection, 's', 'fp', [tool('new_tool', 'dbo.New')]);
  assert.deepEqual(counts, { added: 1, updated: 0, unchanged: 0, removed: 1 });
  const deletes = connection.calls.filter((c) => c.sql.startsWith('DELETE'));
  assert.deepEqual(deletes.map((d) => d.params[0]), ['old']);
});

test('behaviour fingerprint ignores name and description', () => {
  assert.equal(behaviourFingerprint(tool('a')), behaviourFingerprint(tool('b', 'dbo.Tickets', 'Other text here.')));
});

test('missing-scenario generation adds drafts without deleting unrelated saved drafts',async()=>{
 const connection=fakeConnection([row('old',tool('old_draft','dbo.Old')),row('approved',tool('approved_report'),'approved')]);
 const result=await saveDraftDefinitions(connection,'s','fp',[tool('missing_report','dbo.New')],{additive:true});
 assert.equal(result.added,1);assert.equal(result.removed,0);assert.ok(!connection.calls.some(c=>c.sql.startsWith('DELETE')));
});

test('chat generation reuses a saved lookup when only the parameter name changes',async()=>{
 const original={...tool('customer_lookup'),filters:[{field:'dbo.Tickets:Id',operator:'eq',parameter:'filter_value',required:true}]};
 const duplicate={...original,name:'another_lookup',filters:[{...original.filters[0],parameter:'customer_idostring'}]};
 const connection=fakeConnection([row('saved',original,'approved')]);
 const result=await saveDraftDefinitions(connection,'s','fp',[duplicate],{additive:true});assert.equal(result.added,0);assert.equal(result.unchanged,1);assert.ok(!connection.calls.some(c=>c.sql.startsWith('INSERT INTO bi_generated_tools')));
});
