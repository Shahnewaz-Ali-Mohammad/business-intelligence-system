import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from './request-origin.mjs';

test('same-origin loopback requests survive NextURL hostname normalization', () => {
  const request = { url: 'http://localhost:3001/api/test', headers: new Headers({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' }) };
  assert.equal(isSameOriginRequest(request), true);
  for (const origin of ['https://untrusted.example', 'http://localhost:3001', 'http://127.0.0.1:3000', 'https://127.0.0.1:3001', 'null']) {
    assert.equal(isSameOriginRequest({ ...request, headers: new Headers({ host: '127.0.0.1:3001', origin, 'x-forwarded-host': 'untrusted.example' }) }), false);
  }
});
test('ordinary same-origin and non-browser requests retain their existing behavior', () => {
  assert.equal(isSameOriginRequest({ url: 'https://bi.example/api/test', headers: new Headers({ host: 'bi.example', origin: 'https://bi.example' }) }), true);
  assert.equal(isSameOriginRequest({ url: 'http://localhost:3000/api/test', headers: new Headers() }), true);
});
