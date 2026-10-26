import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReport } from './load-report.mjs';

test('loads report data and missing reports without caching', async () => {
  const result = await loadReport('123', { fetchImpl: async (url, options) => {
    assert.equal(url, '/api/reports/123');
    assert.equal(options.cache, 'no-store');
    return Response.json({ report: { id: 123 }, siblingReports: [] });
  } });
  assert.equal(result.report.id, 123);
  assert.equal((await loadReport('404', { fetchImpl: async () => new Response(null, { status: 404 }) })).report, null);
});

test('auth, server and malformed responses cannot leave a report indefinitely loading', async () => {
  for (const [status, pattern] of [[401, /sign in again/], [500, /could not be loaded/]]) {
    await assert.rejects(loadReport('1', { fetchImpl: async () => new Response(null, { status }) }), pattern);
  }
  await assert.rejects(loadReport('1', { fetchImpl: async () => Response.json({ error: 'missing report' }) }), /incomplete report/);
});

test('stalled requests time out and navigation cancels an active request', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(loadReport('1', { fetchImpl, timeoutMs: 10 }), /took too long/);
  const controller = new AbortController();
  const request = loadReport('1', { fetchImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal((await loadReport('1', { fetchImpl: async () => Response.json({ report: { id: 1 } }) })).report.id, 1);
});
