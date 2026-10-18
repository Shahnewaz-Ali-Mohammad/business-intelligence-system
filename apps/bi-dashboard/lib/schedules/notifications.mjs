import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// In-app notifications (e.g. "Scheduled report ready"). Each user has an
// append-only list plus the time they last opened the list, which marks
// everything up to then as read.
const root = process.env.BI_NOTIFICATION_DIR || path.join(process.cwd(), '.data', 'notifications');
const userFile = (userId, name) => {
  const id = String(userId);
  if (!/^\d{1,12}$/.test(id)) throw new Error('Invalid user.');
  return path.join(root, `${id}.${name}`);
};

/** @param {number|string} userId @param {{ title: string, message?: string, reportId?: number | null, status?: string }} input */
export async function addNotification(userId, { title, message = '', reportId = null, status = 'success' }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const item = { id: crypto.randomUUID(), title: String(title).slice(0, 200), message: String(message).slice(0, 500), reportId, status, createdAt: Date.now() };
  await appendFile(userFile(userId, 'ndjson'), JSON.stringify(item) + '\n', { mode: 0o600 });
  return item;
}

export async function listNotifications(userId, limit = 30) {
  const text = await readFile(userFile(userId, 'ndjson'), 'utf8').catch(() => '');
  const items = text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).reverse().slice(0, limit);
  const readAt = Number(await readFile(userFile(userId, 'read'), 'utf8').catch(() => '0')) || 0;
  return { items: items.map((item) => ({ ...item, read: item.createdAt <= readAt })), unread: items.filter((item) => item.createdAt > readAt).length };
}

export async function markNotificationsRead(userId) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(userFile(userId, 'read'), String(Date.now()), { mode: 0o600 });
}
