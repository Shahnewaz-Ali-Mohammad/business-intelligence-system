import test from 'node:test';
import assert from 'node:assert/strict';
import { groundQuery, matchReference, ticketTerms, repairExplicitCategoryAlternatives, QueryGroundingError } from './valueGrounding.mjs';

const dictionary = {
  groups: [
    { cube: 'IspTicketType', id: 'ticket_type_id', name: 'ticket_type_name', values: [{ id: '5', name: 'Fiber Issue' }, { id: '23', name: 'Packet Loss' }, { id: '16', name: 'Backbone Packet Loss Issue' }] },
    { cube: 'IspStatus', id: 'status_id', name: 'status_name', values: [{ id: '1', name: 'ACTIVE' }, { id: '2', name: 'DISCONTINUE' }, { id: '22', name: 'DISCONTINUE' }] },
    { cube: 'IspPop', id: 'pop_id', name: 'pop_name', values: [{ id: '001', name: 'Central POP' }] },
  ],
  codes: [{ member: 'IspCustomer.connection_type', values: ['1', '2', '6'], complete: true }, { member: 'IspTicket.status', values: ['1', '4'], complete: true }],
};
const query = (member, value, operator = 'equals') => ({ dimensions: ['IspTicket.source_ticket_id'], filters: [{ member, operator, values: [value] }] });

test('fiber ticket category repairs an impossible inferred connection filter', () => {
  const actual = groundQuery(query('IspCustomer.connection_type', 'fiber'), dictionary, 'give all fiber tickets category details');
  assert.deepEqual(actual.filters, [{ member: 'IspTicket.ticket_type_id', operator: 'equals', values: ['5'] }]);
});
test('a guessed numeric connection code cannot override an explicit ticket category', () => {
  assert.deepEqual(groundQuery(query('IspCustomer.connection_type', '1'), dictionary, 'all fiber tickets').filters[0], { member: 'IspTicket.ticket_type_id', operator: 'equals', values: ['5'] });
});
test('explicit customer connection wording is not silently rewritten as a ticket type', () => {
  assert.throws(() => groundQuery(query('IspCustomer.connection_type', 'fiber'), dictionary, 'tickets for customers with fiber connection type'), QueryGroundingError);
});
test('named categories resolve to stored IDs without dropping exclusions', () => {
  assert.deepEqual(groundQuery(query('IspTicket.ticket_type_id', 'fiber', 'notEquals'), dictionary).filters[0].values, ['5']);
  assert.equal(groundQuery(query('IspTicket.ticket_type_id', 'fiber', 'notEquals'), dictionary).filters[0].operator, 'notEquals');
});
test('equal labels with different stored IDs include all matching IDs', () => {
  const q = { measures: ['IspCustomer.customer_count'], filters: [{ member: 'IspCustomer.status_id', operator: 'equals', values: ['discontinue'] }] };
  assert.deepEqual(groundQuery(q, dictionary).filters[0].values, ['2', '22']);
});
test('partial ambiguous categories ask for clarification', () => {
  assert.throws(() => groundQuery(query('IspTicket.ticket_type_id', 'loss'), dictionary), /Possible matches/);
});
test('literal reference IDs, leading zeros, and nonexistent numeric IDs are preserved', () => {
  assert.equal(groundQuery(query('IspCustomer.pop_id', '001'), dictionary).filters[0].values[0], '001');
  assert.equal(groundQuery(query('IspTicket.ticket_type_id', '-999'), dictionary).filters[0].values[0], '-999');
});
test('OR filters and numeric/date predicates retain their semantics', () => {
  const q = { dimensions: ['IspBilling.billing_sk'], filters: [{ or: [{ member: 'IspCustomer.status_id', operator: 'equals', values: ['active'] }, { member: 'IspBilling.amount', operator: 'gt', values: ['1000'] }] }], timeDimensions: [{ dimension: 'IspBilling.ref_date', dateRange: ['2026-01-01', '2026-01-31'] }] };
  const actual = groundQuery(q, dictionary);
  assert.equal(actual.filters[0].or[0].values[0], '1');
  assert.deepEqual(actual.filters[0].or[1], q.filters[0].or[1]);
  assert.deepEqual(actual.timeDimensions, q.timeDimensions);
});
test('unmodeled joins and multiple raw financial facts are rejected', () => {
  assert.throws(() => groundQuery({ measures: ['IspCustomer.customer_count'], dimensions: ['IspRegion.division_name'] }, dictionary), /safe modeled join/);
  assert.throws(() => groundQuery({ measures: ['IspBilling.total_billed', 'IspCollection.total_collected'] }, dictionary), /multiply totals/);
  assert.doesNotThrow(() => groundQuery({ measures: ['IspFinancial.total_billed', 'IspFinancial.total_collected'], dimensions: ['IspPop.pop_name'] }, dictionary));
});
test('exact names win over partial overlaps', () => {
  assert.deepEqual(matchReference(dictionary.groups[0], 'Packet Loss').map((r) => r.id), ['23']);
});
test('explicit category followups cannot silently lose their filter', () => {
  assert.throws(() => groundQuery({ dimensions: ['IspTicket.source_ticket_id'] }, dictionary, 'I mean Fiber Issue ticket category. Give all the tickets in that category.'), /dropped its filter/);
});
test('explicit machine-field literal IDs cannot be substituted', () => {
  assert.throws(() => groundQuery(query('IspTicket.ticket_type_id', '5'), dictionary, 'Show all tickets with ticket_type_id equal to -999999.'), /preserve the explicit literal/);
  assert.doesNotThrow(() => groundQuery(query('IspTicket.ticket_type_id', '-999999'), dictionary, 'Show all tickets with ticket_type_id equal to -999999.'));
});
test('date operators cannot be used on category IDs', () => {
  assert.throws(() => groundQuery(query('IspTicket.ticket_type_id', '5', 'inDateRange'), dictionary), /Date operator/);
});
test('category typo matching excludes ordinary request words and prefers full labels', () => {
  const d = structuredClone(dictionary);
  d.groups[0].values.push({ id: '8', name: 'Bandwidth Slow' });
  assert.deepEqual(ticketTerms(d, 'Show full details for ticket ID 1971931.'), []);
  assert.deepEqual(ticketTerms(d, 'Show all tickets with ticket_type_id equal to -999999.'), []);
  assert.deepEqual(ticketTerms(d, 'List all tickets whose ticket category is Fiber Issue OR Packet Loss. Include all ticket columns.').map((r) => r.id).sort(), ['23', '5']);
  assert.deepEqual(ticketTerms(d, 'giv me all fibr issue tikets report').map((r) => r.id), ['5']);
});
test('explicit category alternatives repair only verified category IDs, not date ranges', () => {
  const q = { dimensions: ['IspTicket.ticket_sk'], filters: [{ member: 'IspTicket.ticket_type_id', operator: 'inDateRange', values: ['5', '23'] }] };
  assert.equal(repairExplicitCategoryAlternatives(q, dictionary, 'Tickets for Fiber Issue OR Packet Loss').filters[0].operator, 'equals');
  assert.equal(repairExplicitCategoryAlternatives(q, dictionary, 'Tickets between these dates').filters[0].operator, 'inDateRange');
  assert.equal(repairExplicitCategoryAlternatives({ ...q, filters: [{ ...q.filters[0], values: ['5', '16'] }] }, dictionary, 'Tickets for Fiber Issue OR Packet Loss').filters[0].operator, 'inDateRange');
  assert.equal(q.filters[0].operator, 'inDateRange');
});

test('ordinary request words do not become Need Support category filters', () => {
  const d = structuredClone(dictionary);
  d.groups[0].values.push({ id: '7', name: 'Need Support' });
  const message = 'for all type of tickets i need the customer name and pop';
  assert.deepEqual(ticketTerms(d, message), []);
  assert.deepEqual(ticketTerms(d, 'I need all tickets with customer names'), []);
  assert.deepEqual(ticketTerms(d, 'I want Need Support tickets').map((r) => r.id), ['7']);
  assert.deepEqual(ticketTerms(d, 'List support tickets').map((r) => r.id), ['7']);
  const details = { dimensions: ['IspTicket.source_ticket_id', 'IspTicketType.ticket_type_name', 'IspCustomer.customer_name', 'IspPop.pop_name'] };
  assert.doesNotThrow(() => groundQuery(details, d, message));
  assert.throws(() => groundQuery(query('IspTicket.ticket_type_id', '7'), d, message), /all ticket types/);
  assert.throws(() => groundQuery(query('IspCustomer.connection_type', 'fiber'), d, message), /all ticket types/);
});

test('all-type reset guard preserves explicit categories, identifiers, and other filters', () => {
  for (const message of ['Show all ticket types', 'Show every ticket category', 'For all types of tickets show customer names']) {
    assert.throws(() => groundQuery(query('IspTicket.ticket_type_id', '5'), dictionary, message), /all ticket types/);
  }
  assert.doesNotThrow(() => groundQuery(query('IspTicket.ticket_type_id', '5'), dictionary, 'Show all Fiber Issue tickets'));
  assert.doesNotThrow(() => groundQuery(query('IspTicket.ticket_type_id', '5'), dictionary, 'All ticket types with ticket_type_id equal to 5'));
  const q = query('IspTicket.status', '4');
  assert.deepEqual(groundQuery(q, dictionary, 'Show all ticket types with status 4').filters, q.filters);
});
test('column-list conjunctions do not become invented literal ticket IDs', () => {
  const q = { dimensions: ['IspTicket.source_ticket_id', 'IspTicket.link_id'], filters: [] };
  for (const message of ['List source ticket ID and LinkId', 'Show ticket ID with subject', 'Show ticket ID only']) assert.doesNotThrow(() => groundQuery(q, dictionary, message));
  assert.throws(() => groundQuery(q, dictionary, 'Show ticket ID __MISSING_TICKET__'), /literal/);
});
test('explicit null predicates are grounded by catalog field across spacing and case', () => {
  for (const phrase of ['LinkId', 'link id', 'link_id']) {
    const actual = groundQuery(query('IspTicket.link_id', '', 'notSet'), dictionary, `Show tickets whose ${phrase} is not null`);
    assert.equal(actual.filters[0].operator, 'set'); assert.deepEqual(actual.filters[0].values, []);
  }
  assert.equal(groundQuery(query('IspTicket.link_id', '', 'set'), dictionary, 'LinkId is null').filters[0].operator, 'notSet');
  assert.equal(groundQuery(query('IspTicket.ticket_type_id', '', 'set'), dictionary, 'ticket_type_id is not null').filters[0].operator, 'set');
  const actual = groundQuery(query('IspTicket.link_id', '614110', 'notEquals'), dictionary, 'Show tickets with a populated LinkId excluding 614110');
  assert.ok(actual.filters.some((f) => f.operator === 'set'));
  assert.ok(actual.filters.some((f) => f.operator === 'notEquals' && f.values[0] === ''));
  assert.ok(actual.filters.some((f) => f.operator === 'notEquals' && f.values[0] === '614110'));
});
test('explicit OR identifier alternatives cannot become an invalid date range', () => {
  const q = query('IspTicket.link_id', '34097', 'inDateRange'); q.filters[0].values.push('614110');
  assert.equal(repairExplicitCategoryAlternatives(q, dictionary, 'Show tickets with LinkId 34097 OR LinkId 614110').filters[0].operator, 'equals');
  assert.equal(repairExplicitCategoryAlternatives(q, dictionary, 'Tickets between these dates').filters[0].operator, 'inDateRange');
});
