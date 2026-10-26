import { createHash, randomBytes } from 'crypto';
import { getAppDb } from '@/lib/db/app-db';
import { encryptConnectionString, decryptConnectionString } from '@/lib/workspaces/secrets';
import { newSecret, verifyCode, otpauthUrl } from './totp.mjs';

// Two-step sign-in. Admin and CEO accounts must use it; anyone may turn it on.
// A password alone never creates a session for an account that has it: the
// sign-in waits as a short-lived ticket until the 6-digit code is entered.

export const MFA_REQUIRED_ROLES = ['admin', 'ceo'];
export const mfaRequiredFor = (roles: string[]) => process.env.BI_REQUIRE_MFA === 'on' && roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type Row = { secret: string; enabled_at: unknown; last_step: number | null };
async function row(userId: number): Promise<Row | null> {
  const [rows] = await getAppDb().execute('SELECT secret, enabled_at, last_step FROM user_mfa WHERE user_id=?', [userId]);
  return (rows as Row[])[0] || null;
}
export async function mfaEnabled(userId: number) { return !!(await row(userId))?.enabled_at; }

/** Checks a code and records its time step so the same code cannot be used twice. */
async function checkCode(userId: number, code: string, requireEnabled: boolean) {
  const r = await row(userId);
  if (!r || (requireEnabled && !r.enabled_at)) return false;
  const step = verifyCode(decryptConnectionString(r.secret), code, { lastStep: r.last_step ?? -1 });
  if (step == null) return false;
  const [result] = await getAppDb().execute('UPDATE user_mfa SET last_step=? WHERE user_id=? AND (last_step IS NULL OR last_step < ?)', [step, userId, step]);
  return (result as { affectedRows: number }).affectedRows === 1;
}

/** A new (not yet active) authenticator secret for this person. */
export async function startSetup(userId: number, email: string) {
  const secret = newSecret();
  await getAppDb().execute('INSERT INTO user_mfa (user_id, secret, enabled_at, last_step) VALUES (?, ?, NULL, NULL) ON DUPLICATE KEY UPDATE secret=IF(enabled_at IS NULL, VALUES(secret), secret), last_step=IF(enabled_at IS NULL, NULL, last_step)', [userId, encryptConnectionString(secret)]);
  const r = await row(userId);
  if (r?.enabled_at) throw new Error('Two-step sign-in is already on.');
  return { secret, url: otpauthUrl(secret, email) };
}
export async function finishSetup(userId: number, code: string) {
  if (!(await checkCode(userId, code, false))) throw new Error('That code is not right. Check the time on your phone and try the newest code.');
  await getAppDb().execute('UPDATE user_mfa SET enabled_at=NOW() WHERE user_id=?', [userId]);
}
export async function turnOff(userId: number, code: string) {
  if (!(await checkCode(userId, code, true))) throw new Error('That code is not right.');
  await getAppDb().execute('DELETE FROM user_mfa WHERE user_id=?', [userId]);
}
/** Admin reset when a phone is lost: the person sets it up again at next sign-in. */
export async function resetMfa(userId: number) { await getAppDb().execute('DELETE FROM user_mfa WHERE user_id=?', [userId]); }

/** After a correct password: a 5-minute ticket that the code turns into a session. */
export async function createPendingLogin(userId: number) {
  const ticket = randomBytes(32).toString('hex');
  await getAppDb().execute('DELETE FROM pending_logins WHERE expires_at < NOW()');
  await getAppDb().execute('INSERT INTO pending_logins (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))', [hash(ticket), userId]);
  return ticket;
}
/** Returns the user id when the code is right; five wrong codes cancel the ticket. */
export async function completePendingLogin(ticket: string, code: string) {
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error('Sign in again.');
  const [rows] = await getAppDb().execute('SELECT user_id, attempts FROM pending_logins WHERE token_hash=? AND expires_at > NOW()', [hash(ticket)]);
  const pending = (rows as { user_id: number; attempts: number }[])[0];
  if (!pending || pending.attempts >= 5) throw new Error('This sign-in expired. Enter your password again.');
  if (!(await checkCode(pending.user_id, code, true))) {
    await getAppDb().execute('UPDATE pending_logins SET attempts=attempts+1 WHERE token_hash=?', [hash(ticket)]);
    throw new Error('That code is not right.');
  }
  await getAppDb().execute('DELETE FROM pending_logins WHERE token_hash=?', [hash(ticket)]);
  return pending.user_id;
}
