import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOnce } from './request-execution.mjs';

test('parallel and later retries share exactly one execution within a request', async () => {
  const cache = new Map();
  let calls = 0;
  const execute = async () => ({ rows: [++calls], summary: { population: 12483367 } });
  const results = await Promise.all([executeOnce(cache, 'approved-tool/query', execute), executeOnce(cache, 'approved-tool/query', execute)]);
  assert.equal(results[0], results[1]);
  assert.equal(await executeOnce(cache, 'approved-tool/query', execute), results[0]);
  assert.equal(calls, 1);
  await executeOnce(new Map(), 'approved-tool/query', execute);
  assert.equal(calls, 2);
});

test('failures can retry and different queries never share results', async () => {
  const cache = new Map();
  await assert.rejects(executeOnce(cache, 'one', async () => { throw new Error('failed'); }));
  assert.equal(await executeOnce(cache, 'one', async () => 1), 1);
  assert.equal(await executeOnce(cache, 'two', async () => 2), 2);
});
