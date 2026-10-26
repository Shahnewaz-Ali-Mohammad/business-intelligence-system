import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceValue, proposalToForm, todayIn } from './procedure-fill.mjs';

const P = (name, type, extra = {}) => ({ name, type, baseType: type, ...extra });

test('values are made valid for each SQL type, or dropped', () => {
  assert.equal(coerceValue(P('@From', 'date'), '2026-01-01'), '2026-01-01');
  assert.equal(coerceValue(P('@From', 'date'), 'January'), undefined);
  assert.equal(coerceValue(P('@At', 'datetime'), '2026-01-31'), '2026-01-31T00:00');
  assert.equal(coerceValue(P('@At', 'datetime2'), '2026-01-31 18:30'), '2026-01-31T18:30');
  assert.equal(coerceValue(P('@Zone', 'int'), '1,204'), '1204');
  assert.equal(coerceValue(P('@Zone', 'int'), 'Dhaka'), undefined);
  assert.equal(coerceValue(P('@Rate', 'decimal'), '12.5'), '12.5');
  assert.equal(coerceValue(P('@Active', 'bit'), 'yes'), '1');
  assert.equal(coerceValue(P('@Name', 'nvarchar', { maxLength: 4 }), 'Dhaka North'), 'Dhak');
});

test('the form gets filled, default and missing fields', () => {
  const params = [P('@FromDate', 'date'), P('@ToDate', 'date'), P('@ZoneId', 'int'), P('@Status', 'varchar', { hasDefault: true }), P('@Total', 'int', { output: true })];
  const form = proposalToForm(params, { values: [{ name: 'FromDate', value: '2026-01-01' }, { name: '@ToDate', value: '2026-01-31' }, { name: '@ZoneId', value: 'Dhaka' }] });
  assert.deepEqual(form.filled, ['@FromDate', '@ToDate']);
  assert.deepEqual(form.missing, ['@ZoneId']);
  assert.equal(form.modes['@Status'], 'default');
  assert.equal(form.modes['@Total'], 'output');
  assert.equal(form.values['@ToDate'], '2026-01-31');
});

test('today is taken in the person\'s timezone', () => {
  const now = Date.parse('2026-01-31T20:00:00Z');
  assert.equal(todayIn('Asia/Dhaka', now).date, '2026-02-01');
  assert.equal(todayIn('UTC', now).date, '2026-01-31');
});
