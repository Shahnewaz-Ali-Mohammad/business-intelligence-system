import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, codeAt, verifyCode, newSecret } from './totp.mjs';

// RFC 6238 test secret "12345678901234567890" (SHA-1).
const secret = base32Encode(Buffer.from('12345678901234567890'));

test('matches the RFC 6238 reference codes', () => {
  assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeAt(secret, Math.floor(1234567890 / 30)), '005924');
});

test('base32 round trip', () => {
  const s = newSecret();
  assert.equal(base32Encode(base32Decode(s)), s);
});

test('accepts one step of drift, refuses reuse and wrong codes', () => {
  const now = 1234567890 * 1000;
  const step = Math.floor(now / 30000);
  assert.equal(verifyCode(secret, codeAt(secret, step), { now }), step);
  assert.equal(verifyCode(secret, codeAt(secret, step - 1), { now }), step - 1);
  assert.equal(verifyCode(secret, codeAt(secret, step - 2), { now }), null);
  assert.equal(verifyCode(secret, codeAt(secret, step), { now, lastStep: step }), null);
  assert.equal(verifyCode(secret, 'abcdef', { now }), null);
});
