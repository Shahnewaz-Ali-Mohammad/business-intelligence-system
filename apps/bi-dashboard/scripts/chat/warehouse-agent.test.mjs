import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBooleanIntent, verifyReferenceIntent, groundNullFilters, groundRecordList } from './warehouse-agent.mjs';

test('explicit keyed record lists do not become redundant count-by-record aggregates', () => {
  const catalog = [{ name: 'Tickets', stableRecords: true, dimensions: [{ name: 'Tickets.id', primaryKey: true }] }];
  const make = () => ({ dimensions: ['Tickets.id'], measures: ['Tickets.record_count'], filters: [] });
  const query = make(); groundRecordList('List Tickets where Amount is greater than 2000.', query, catalog);
  assert.deepEqual(query.measures, []);
  for (const message of ['Count tickets', 'List count grouped by status', 'List average amount']) {
    const aggregate = make(); groundRecordList(message, aggregate, catalog); assert.deepEqual(aggregate.measures, ['Tickets.record_count']);
  }
  const having = make(); having.filters = [{ member: 'Tickets.record_count', operator: 'gt', values: ['2'] }];
  groundRecordList('List tickets', having, catalog); assert.deepEqual(having.measures, ['Tickets.record_count']);
  const numeric = make(); numeric.measures = ['Tickets.amount_sum']; groundRecordList('List tickets', numeric, catalog); assert.deepEqual(numeric.measures, ['Tickets.amount_sum']);
});

test('explicit OR filters cannot silently execute as AND', () => {
  const filters = [{ member: 'T.amount', operator: 'lt', values: ['3'] }, { member: 'T.amount', operator: 'gt', values: ['1999'] }];
  assert.throws(() => verifyBooleanIntent('Amount <3 OR Amount >1999', { filters }), /OR/);
  assert.doesNotThrow(() => verifyBooleanIntent('Amount <3 OR Amount >1999', { filters: [{ or: filters }] }));
  assert.throws(() => verifyBooleanIntent('Amount <3 OR Amount >1999', { filters: [filters[0], { or: filters }] }), /duplicates/);
  assert.doesNotThrow(() => verifyBooleanIntent('Amount <3 AND Amount >1999', { filters }));
  assert.doesNotThrow(() => verifyBooleanIntent('Type is A or B', { filters: [{ member: 'T.type', operator: 'equals', values: ['A', 'B'] }] }));
});
test('explicit null predicates cannot be inverted or treated as string values', () => {
  const catalog = [{ name: 'Tickets', dimensions: [{ name: 'Tickets.link', title: 'LinkId' }] }];
  const query = { dimensions: ['Tickets.link'], filters: [{ member: 'Tickets.link', operator: 'notSet', values: [''] }] };
  groundNullFilters('List Tickets where LinkId is not null', query, catalog);
  assert.deepEqual(query.filters, [{ member: 'Tickets.link', operator: 'set', values: [] }]);
  groundNullFilters('Show tickets whose link id is not null', query, catalog);
  assert.equal(query.filters[0].operator, 'set');
  groundNullFilters('List Tickets where LinkId is null', query, catalog);
  assert.equal(query.filters[0].operator, 'notSet');
  const both = { dimensions: ['Tickets.link'], filters: [{ and: [{ member: 'Tickets.link', operator: 'set', values: [] }, { member: 'Tickets.link', operator: 'notSet', values: [] }] }] };
  const original = structuredClone(both);
  groundNullFilters('LinkId is null AND LinkId is not null', both, catalog);
  assert.deepEqual(both, original);
  assert.throws(() => groundNullFilters('LinkId is not null', { dimensions: ['Tickets.link'], filters: [] }, catalog), /Preserve/);
  const literal = { dimensions: ['Tickets.link'], filters: [{ member: 'Tickets.link', operator: 'equals', values: ['null'] }] };
  groundNullFilters("LinkId equals 'null'", literal, catalog);
  assert.equal(literal.filters[0].operator, 'equals');
  const combined = { dimensions: ['Tickets.link'], filters: [{ member: 'Tickets.link', operator: 'set', values: [] }, { member: 'Tickets.link', operator: 'notEquals', values: ['L-42'] }] };
  groundNullFilters('LinkId is not null and LinkId is not L-42', combined, catalog);
  assert.equal(combined.filters[1].operator, 'notEquals');
});
test('latest named category cannot retain a conflicting previous lookup ID', () => {
  const catalog = [{ name: 'Type', dimensions: [{ name: 'Type.id', title: 'TicketTypeID' }], joins: [] }, { name: 'Tickets', dimensions: [{ name: 'Tickets.type', title: 'TicketTypeID' }], joins: [{ name: 'Type' }] }];
  const dictionary = [{ table: 'TicketType', id: 'Type.id', label: 'Type.label', values: [{ 'Type.id': '5', 'Type.label': 'Fiber Issue' }, { 'Type.id': '23', 'Type.label': 'Packet Loss' }] }];
  assert.throws(() => verifyReferenceIntent('List all Packet Loss tickets', { filters: [{ member: 'Tickets.type', operator: 'equals', values: ['5'] }] }, dictionary, catalog), /explicit category/);
  assert.doesNotThrow(() => verifyReferenceIntent('List all Packet Loss tickets', { filters: [{ member: 'Tickets.type', operator: 'equals', values: ['23'] }] }, dictionary, catalog));
  assert.doesNotThrow(() => verifyReferenceIntent('Exclude Fiber Issue tickets', { filters: [{ member: 'Tickets.type', operator: 'notEquals', values: ['5'] }] }, dictionary, catalog));
  const stale = { filters: [{ member: 'Tickets.type', operator: 'equals', values: ['5'] }] };
  verifyReferenceIntent('List all Packet Loss tickets', stale, dictionary, catalog, true);
  assert.deepEqual(stale.filters[0].values, ['23']);
  assert.throws(() => verifyReferenceIntent('TicketTypeID 5 Packet Loss details', { filters: [{ member: 'Tickets.type', operator: 'equals', values: ['5'] }] }, dictionary, catalog, true), /explicit category/);
});
