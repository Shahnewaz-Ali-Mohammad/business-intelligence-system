import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleText, presetRange, applyRangeToQuery, applyRangeToProcedure } from './schedule-intent.mjs';

test('parses question, weekday, time and range', () => {
  const r = parseScheduleText('/schedule customers per package every Monday at 9am for last week');
  assert.equal(r.question, 'customers per package');
  assert.deepEqual(r.schedule, { frequency: 'weekly', time: '09:00', dayOfWeek: 1 });
  assert.equal(r.dateRange, 'last_week');
});
test('parses daily, monthly and 24h time', () => {
  assert.deepEqual(parseScheduleText('/schedule total billing daily at 18:30').schedule, { frequency: 'daily', time: '18:30' });
  const m = parseScheduleText('/schedule billing summary monthly on the 1st at 8am for last month');
  assert.deepEqual(m.schedule, { frequency: 'monthly', time: '08:00', dayOfMonth: 1 });
  assert.equal(m.dateRange, 'last_month');
  assert.equal(m.question, 'billing summary');
});
test('no schedule words leaves everything to the form', () => {
  assert.deepEqual(parseScheduleText('/schedule').schedule, { frequency: null, time: null });
});
test('rolling ranges in a timezone', () => {
  const now = Date.parse('2026-10-18T02:00:00Z'); // Sunday 08:00 in Dhaka
  assert.deepEqual(presetRange('yesterday', 'Asia/Dhaka', now), { start: '2026-10-17', end: '2026-10-18' });
  assert.deepEqual(presetRange('last_month', 'Asia/Dhaka', now), { start: '2026-09-01', end: '2026-10-01' });
  assert.deepEqual(presetRange('last_week', 'Asia/Dhaka', now), { start: '2026-10-05', end: '2026-10-12' });
  assert.deepEqual(presetRange('last_month', 'UTC', Date.parse('2026-01-15T00:00:00Z')), { start: '2025-12-01', end: '2026-01-01' });
});
test('moves existing date filters, adds one for date-grouped reports', () => {
  const isDate = (f) => /Date$/.test(f);
  const range = { start: '2026-09-01', end: '2026-10-01' };
  const moved = JSON.parse(applyRangeToQuery(JSON.stringify({ where: { and: [{ field: 't:EntryDate', operator: 'gte', value: '2025-01-01' }, { field: 't:EntryDate', operator: 'lte', value: '2025-12-31' }, { field: 't:Status', operator: 'eq', value: 1 }] } }), range, isDate));
  assert.deepEqual(moved.where.and, [{ field: 't:EntryDate', operator: 'gte', value: '2026-09-01' }, { field: 't:EntryDate', operator: 'lt', value: '2026-10-01' }, { field: 't:Status', operator: 'eq', value: 1 }]);
  const added = JSON.parse(applyRangeToQuery(JSON.stringify({ dateGroups: [{ field: 't:EntryDate', grain: 'day' }] }), range, isDate));
  assert.deepEqual(added.where, { and: [{ field: 't:EntryDate', operator: 'gte', value: '2026-09-01' }, { field: 't:EntryDate', operator: 'lt', value: '2026-10-01' }] });
  const untouched = JSON.stringify({ groupBy: ['t:Status'] });
  assert.equal(applyRangeToQuery(untouched, range, isDate), untouched);
});
test('sets procedure start/end date parameters', () => {
  const params = [{ name: '@StartDate', type: 'datetime' }, { name: '@EndDate', type: 'datetime' }, { name: '@STATUS', type: 'int' }];
  assert.deepEqual(applyRangeToProcedure({ '@StartDate': '2025-01-01', '@EndDate': '2025-01-31', '@STATUS': '1' }, params, { start: '2026-09-01', end: '2026-10-01' }), { '@StartDate': '2026-09-01', '@EndDate': '2026-09-30', '@STATUS': '1' });
});
