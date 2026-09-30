// Encrypts/decrypts source-database connection strings before they touch
// workspace_connections.encrypted_conn_string -- the raw connection string
// (which contains a real password to a customer's production database)
// must never be stored in plain text or appear in a log line.
//
// AES-256-GCM with a key from WORKSPACE_SECRETS_KEY (.env.local), not a
// cloud secrets manager (Vault/AWS Secrets Manager) -- this system runs on
// a single VPS, not cloud infra with one of those services available, so
// a symmetric key at rest is the right amount of machinery here. If this
// ever moves to infra with a real secrets manager, only this file needs to
// change -- every caller already goes through encryptConnectionString /
// decryptConnectionString, never the raw bytes.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.WORKSPACE_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      'WORKSPACE_SECRETS_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env.local.'
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error('WORKSPACE_SECRETS_KEY must decode to exactly 32 bytes (a 64-char hex string).');
  }
  return key;
}

// Stored as iv:authTag:ciphertext, all hex, so it's a single TEXT column
// value with no ambiguity about where one part ends and the next begins.
export function encryptConnectionString(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptConnectionString(stored: string): string {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Stored connection string is not in the expected iv:authTag:ciphertext format.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
