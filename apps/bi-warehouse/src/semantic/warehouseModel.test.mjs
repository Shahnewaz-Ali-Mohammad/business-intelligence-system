import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWarehouseModel, parseModel, serializeModel, modelCatalog, validateWarehouseQuery, quote, sensitiveColumn, sensitiveTable } from './warehouseModel.mjs';
import { connectionConfig } from '../introspection/discoverWarehouse.mjs';

const workspace = '01234567-0123-4123-8123-012345678901';
const column = (name, type = 'integer', pk = false) => ({ name, dataType: type, isPrimaryKey: pk });
const table = (name, columns) => ({ key: `example.${name}`, schema: 'example', name, columns });
const discovery = { schemas: ['example'], fingerprint: 'schema', connectionFingerprint: 'connection', tables: [table('Tickets', [column('TicketId', 'bigint', true), column('StatusId'), column('Subject', 'text'), column('Amount', 'numeric'), column('CreatedAt', 'timestamp without time zone'), column('Password', 'text')]), table('Status', [column('StatusId', 'integer', true), column('StatusName', 'text')]), table('Payments', [column('PaymentId', 'integer', true), column('TicketId', 'bigint'), column('Amount', 'numeric')]), table('UserTokens', [column('Id', 'integer', true)])], joins: [{ id: 'fk', from: 'example.Tickets', to: 'example.Status', columns: [{ from: 'StatusId', to: 'StatusId' }] }], candidates: [] };
const build = () => buildWarehouseModel(discovery, workspace, ['example.Tickets', 'example.Status', 'example.Payments']);
const find = (model, tableName, title) => { const c = modelCatalog(model).find((c) => c.table === tableName); return [...c.measures, ...c.dimensions].find((f) => f.title === title)?.name; };
test('automatic model safely quotes identifiers and removes restricted data', () => {
  const m = build();
  assert.equal(quote('a"b'), '"a""b"');
  assert.equal(m.cubes[0].sql_table, '"example"."Tickets"');
  assert.equal(find(m, 'example.Tickets', 'Password'), undefined);
  assert.equal(modelCatalog(m)[0].dimensions.find((d) => d.title === 'TicketId').type, 'string');
  assert.ok(m.cubes[0].dimensions.find((d) => d.title === 'TicketId').sql.endsWith('::text'));
  assert.ok(sensitiveColumn('AccessToken')); assert.ok(sensitiveTable('UserTokens'));
  assert.equal(sensitiveColumn('SNID'), false); assert.equal(sensitiveColumn('MkPass'), true);
  assert.throws(() => buildWarehouseModel(discovery, workspace, ['example.UserTokens']), /restricted/);
});
test('model round trip detects alteration', () => {
  const m = build(); assert.deepEqual(parseModel(serializeModel(m)), m);
  assert.throws(() => parseModel(serializeModel(m).replace('StatusName', 'OtherName')), /fingerprint/);
});
test('only declared or explicitly reviewed primary-key joins are included', () => {
  const m = build(); assert.equal(m.cubes[0].joins.length, 1); assert.equal(m.cubes[2].joins.length, 0);
  const candidate = { id: 'guess', from: 'example.Payments', to: 'example.Tickets', columns: [{ from: 'TicketId', to: 'TicketId' }] };
  assert.equal(buildWarehouseModel({ ...discovery, candidates: [candidate] }, workspace, ['example.Payments', 'example.Tickets']).cubes[0].joins.length, 0);
  assert.equal(buildWarehouseModel({ ...discovery, candidates: [candidate] }, workspace, ['example.Payments', 'example.Tickets'], ['guess']).cubes.find((c) => c.meta.table_key === 'example.Payments').joins.length, 1);
  assert.throws(() => buildWarehouseModel(discovery, workspace, ['example.Tickets'], ['bad']), /Unknown/);
});
test('valid filters, date groupings, literal IDs and joins pass', () => {
  const m = build(), catalog = modelCatalog(m);
  const query = { measures: [catalog[0].measures[0].name], dimensions: [find(m, 'example.Status', 'StatusName')], filters: [{ and: [{ member: find(m, 'example.Tickets', 'TicketId'), operator: 'equals', values: ['0009007199254740993'] }, { member: find(m, 'example.Tickets', 'Amount'), operator: 'gte', values: ['20'] }] }], timeDimensions: [{ dimension: find(m, 'example.Tickets', 'CreatedAt'), dateRange: ['2025-01-01', '2025-12-31'], granularity: 'month' }] };
  assert.equal(validateWarehouseQuery(m, query).timezone, 'Asia/Dhaka');
});
test('unapproved fields, SQL, unsafe joins and mixed metric grains are blocked', () => {
  const m = build(), catalog = modelCatalog(m);
  assert.throws(() => validateWarehouseQuery(m, { dimensions: ['wrong.field'] }), /Unavailable/);
  assert.throws(() => validateWarehouseQuery(m, { measures: [catalog[0].measures[0].name], sql: 'DROP TABLE test' }), /Unsupported/);
  assert.throws(() => validateWarehouseQuery(m, { dimensions: [catalog[0].dimensions[0].name, catalog[2].dimensions[0].name] }), /relationship/);
  assert.throws(() => validateWarehouseQuery(m, { measures: [catalog[0].measures[0].name, catalog[2].measures[0].name] }));
  assert.throws(() => validateWarehouseQuery(m, { dimensions: [catalog[0].dimensions[0].name], filters: [{ member: catalog[0].dimensions[0].name, operator: 'inDateRange', values: ['1', '2'] }] }), /Date/);
});
test('aggregate counts and sums accept numeric HAVING filters', () => {
  const m = build(), catalog = modelCatalog(m);
  for (const metric of catalog[0].measures) {
    assert.doesNotThrow(() => validateWarehouseQuery(m, { measures: [metric.name], dimensions: [find(m, 'example.Status', 'StatusName')], filters: [{ member: metric.name, operator: 'gte', values: ['1001'] }] }));
  }
});
test('composite primary key gets one collision-safe hidden key', () => {
  const d = { ...discovery, tables: [table('Composite', [column('FirstId', 'integer', true), column('SecondId', 'integer', true)])], joins: [] };
  const m = buildWarehouseModel(d, workspace, ['example.Composite']);
  assert.equal(m.cubes[0].dimensions.filter((d) => d.primary_key).length, 1);
  assert.equal(m.cubes[0].dimensions.find((d) => d.primary_key).public, false);
  assert.ok(m.cubes[0].dimensions.find((d) => d.primary_key).sql.includes('jsonb_build_array'));
});
test('joins without a source primary key cannot produce unsafe metric counts', () => {
  const d = { ...discovery, tables: discovery.tables.map((t) => t.name === 'Tickets' ? { ...t, columns: t.columns.map((c) => ({ ...c, isPrimaryKey: false })) } : t) };
  const m = buildWarehouseModel(d, workspace, ['example.Tickets', 'example.Status']);
  assert.equal(m.cubes[0].joins.length, 0);
  assert.ok(m.warnings.some((w) => w.includes('safe joined metrics')));
});
test('connection URL cannot inject driver options or connect to unapproved hosts', () => {
  assert.equal(connectionConfig('postgresql://reader:p%40ss@localhost:5432/warehouse').password, 'p@ss');
  assert.throws(() => connectionConfig('postgresql://u:p@unapproved.example/db'), /approved/);
  assert.throws(() => connectionConfig('postgresql://u:p@localhost/db?options=-c%20allow_system_table_mods=on'), /option/);
});
