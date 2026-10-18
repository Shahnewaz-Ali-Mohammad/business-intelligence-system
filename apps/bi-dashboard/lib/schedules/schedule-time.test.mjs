import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSchedule, nextRunAt } from './schedule-time.mjs';

const at = (iso) => Date.parse(iso);
test('daily runs later today, else tomorrow, in the given timezone', () => {
  const s = cleanSchedule({ frequency: 'daily', time: '08:00', timezone: 'Asia/Dhaka' });
  assert.equal(new Date(nextRunAt(s, at('2026-10-18T01:00:00Z'))).toISOString(), '2026-10-18T02:00:00.000Z');
  assert.equal(new Date(nextRunAt(s, at('2026-10-18T02:00:00Z'))).toISOString(), '2026-10-19T02:00:00.000Z');
});
test('weekly picks the next matching weekday', () => {
  const s = cleanSchedule({ frequency: 'weekly', time: '09:30', timezone: 'UTC', dayOfWeek: 1 });
  assert.equal(new Date(nextRunAt(s, at('2026-10-18T12:00:00Z'))).toISOString(), '2026-10-19T09:30:00.000Z');
});
test('monthly day 31 falls back to the last day of shorter months', () => {
  const s = cleanSchedule({ frequency: 'monthly', time: '07:00', timezone: 'UTC', dayOfMonth: 31 });
  assert.equal(new Date(nextRunAt(s, at('2026-11-01T00:00:00Z'))).toISOString(), '2026-11-30T07:00:00.000Z');
});
test('daylight-saving timezones keep the local time', () => {
  const s = cleanSchedule({ frequency: 'daily', time: '08:00', timezone: 'America/New_York' });
  assert.equal(new Date(nextRunAt(s, at('2026-11-02T00:00:00Z'))).toISOString(), '2026-11-02T13:00:00.000Z');
  assert.equal(new Date(nextRunAt(s, at('2026-10-30T00:00:00Z'))).toISOString(), '2026-10-30T12:00:00.000Z');
});
test('invalid schedules are rejected', () => {
  assert.throws(() => cleanSchedule({ frequency: 'hourly', time: '08:00' }));
  assert.throws(() => cleanSchedule({ frequency: 'daily', time: '25:00' }));
});
