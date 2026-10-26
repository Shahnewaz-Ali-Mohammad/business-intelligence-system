import crypto from 'node:crypto';

// Time-based one-time codes (RFC 6238), the 6-digit codes shown by
// authenticator apps such as Google Authenticator or Microsoft Authenticator.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  const number = (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

/**
 * Checks a code, allowing one step of clock drift either way. Returns the
 * step that matched so the caller can refuse the same code twice.
 */
export function verifyCode(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    const given = Buffer.from(String(code).trim());
    if (crypto.timingSafeEqual(expected, given)) return step;
  }
  return null;
}

export const otpauthUrl = (secret, account, issuer = 'Business Intelligence') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
