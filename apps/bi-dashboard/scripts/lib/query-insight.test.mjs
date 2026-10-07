import assert from 'node:assert/strict';
import test from 'node:test';
import { describeQuery, recordListSummaryQuery } from './query-insight.mjs';

test('named ticket/customer lists retain their exact filters in full-population summaries', () => {
  const tickets = recordListSummaryQuery('get_ticket_list', { ticketTypeId: '19', departmentId: '2', status: '4', dateFrom: '2025-01-01', dateTo: '2025-01-31', limit: 5 });
  assert.deepEqual(tickets.measures, []);
  assert.ok(tickets.dimensions.includes('IspTicket.customer_id'));
  assert.ok(tickets.filters.some((f) => f.member === 'IspTicket.status' && f.values[0] === '4'));
  assert.equal(tickets.limit, 5);
  assert.deepEqual(tickets.timeDimensions[0].dateRange, ['2025-01-01', '2025-01-31']);
  const customers = recordListSummaryQuery('get_customer_list', { popId: '001', packageId: '3', dateField: 'activated', dateFrom: '2025-01-01' });
  assert.equal(customers.timeDimensions[0].dimension, 'IspCustomer.activated_date');
  assert.equal(customers.filters[0].or[0].values[0], '001');
  assert.equal(customers.timeDimensions[0].dateRange[1], '9999-12-31');
});

test('summaries use full filtered aggregates, not page sums or ranked limits', async () => {
  const calls = [];
  const query = { measures: ['IspBilling.total_billed'], dimensions: ['IspCustomer.pop_id'], filters: [{ member: 'IspBilling.amount', operator: 'gt', values: ['100'] }], timeDimensions: [{ dimension: 'IspBilling.ref_date', dateRange: ['2026-01-01', '2026-01-31'], granularity: 'day' }], limit: 20 };
  const result = await describeQuery(query, { total: 20, rows: [{ 'IspBilling.total_billed': 1 }] }, 'Billing by POP', async (q) => {
    calls.push(q);
    return q.dimensions ? [{ 'IspCustomer.pop_id': '001', 'IspBilling.total_billed': 700 }] : [{ 'IspBilling.total_billed': 1000 }];
  });
  assert.equal(result.title, 'Billing by POP');
  assert.match(result.narrative, /BDT 1,000/);
  assert.match(result.narrative, /001/);
  assert.deepEqual(calls[0].filters, query.filters);
  assert.deepEqual(calls[0].timeDimensions, [{ dimension: 'IspBilling.ref_date', dateRange: ['2026-01-01', '2026-01-31'] }]);
  assert.equal(calls[0].limit, undefined);
});

test('aggregate threshold populations preserve grouping for their leader', async () => {
  const query = { measures: ['IspBilling.total_billed'], dimensions: ['IspCustomer.pop_id'], filters: [{ or: [{ member: 'IspBilling.total_billed', operator: 'gt', values: ['100'] }] }] };
  const result = await describeQuery(query, { total: 8, rows: [] }, 'High Billing', async (q) => {
    assert.deepEqual(q.dimensions, query.dimensions);
    assert.deepEqual(q.filters, query.filters);
    return [{ 'IspBilling.total_billed': 900, 'IspCustomer.pop_id': '005' }];
  });
  assert.match(result.narrative, /aggregate thresholds/);
  assert.match(result.narrative, /BDT 900/);
});

test('missing aggregates remain unavailable, not fabricated zeros', async () => {
  const result = await describeQuery({ measures: ['IspFinancial.collection_rate'] }, { total: 1, rows: [] }, '', async () => [{ 'IspFinancial.collection_rate': null }]);
  assert.equal(result.title, 'Financial Report');
  assert.match(result.narrative, /unavailable/);
  assert.doesNotMatch(result.narrative, /is 0/);
});

test('summary failure preserves records with an explicit limitation', async () => {
  const result = await describeQuery({ dimensions: ['IspCustomer.customer_id'] }, { total: 1, rows: [{ 'IspCustomer.customer_id': '000001' }] }, 'Customer Details', async () => { throw new Error('Unavailable'); });
  assert.match(result.narrative, /could not be calculated/);
  assert.match(result.narrative, /000001/);
});
