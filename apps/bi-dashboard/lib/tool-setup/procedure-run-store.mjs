import { mkdir, open, readFile, rename, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';

// Stored procedure results are kept on disk, one newline-delimited JSON file
// per result table plus a fixed-width index of byte offsets (one entry every
// PAGE_ROWS rows), so any page of any size result is read directly without
// loading the rest.
export const PAGE_ROWS = 100;
const OFFSET_WIDTH = 16; // 15 digits + newline
const root = process.env.BI_PROCEDURE_RUN_DIR || path.join(process.cwd(), '.data', 'procedure-runs');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runDirectory(workspaceId, runId) {
  if (!uuid.test(workspaceId) && workspaceId !== 'isp-default') throw new Error('Invalid workspace.');
  if (!uuid.test(runId)) throw new Error('Invalid report run.');
  return path.join(root, workspaceId, runId);
}
const metaFile = (workspaceId, runId) => path.join(runDirectory(workspaceId, runId), 'run.json');
const dataFile = (workspaceId, runId, set) => path.join(runDirectory(workspaceId, runId), `result-${Number(set)}.ndjson`);
const indexFile = (workspaceId, runId, set) => path.join(runDirectory(workspaceId, runId), `result-${Number(set)}.idx`);
const cancelFile = (workspaceId, runId) => path.join(runDirectory(workspaceId, runId), 'cancel');

export async function writeRun(workspaceId, run) {
  const target = metaFile(workspaceId, run.id);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(run), { mode: 0o600 });
  await rename(temporary, target);
  return run;
}
export async function createRun(workspaceId, input) {
  const id = crypto.randomUUID();
  await mkdir(runDirectory(workspaceId, id), { recursive: true, mode: 0o700 });
  return writeRun(workspaceId, { id, workspaceId, status: 'queued', progress: 'Waiting to start', resultSets: [], createdAt: Date.now(), ...input });
}
export async function readRun(workspaceId, runId) {
  try { return JSON.parse(await readFile(metaFile(workspaceId, runId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function requestCancel(workspaceId, runId) { await writeFile(cancelFile(workspaceId, runId), String(Date.now())); }
export async function cancelRequested(workspaceId, runId) { return stat(cancelFile(workspaceId, runId)).then(() => true, () => false); }

/** Appends rows of one result table and keeps its page index current. */
export async function openResultWriter(workspaceId, runId, set) {
  const data = await open(dataFile(workspaceId, runId, set), 'w', 0o600);
  const index = await open(indexFile(workspaceId, runId, set), 'w', 0o600);
  let bytes = 0; let rows = 0; let buffer = []; let offsets = [];
  // Writes are chained so file order always matches row order.
  let chain = Promise.resolve();
  const flush = () => {
    const indexChunk = offsets.join(''); offsets = [];
    const dataChunk = buffer.join(''); buffer = [];
    chain = chain.then(async () => { if (indexChunk) await index.write(indexChunk); if (dataChunk) await data.write(dataChunk); });
    return chain;
  };
  return {
    async add(row) {
      if (rows % PAGE_ROWS === 0) offsets.push(String(bytes).padStart(OFFSET_WIDTH - 1, '0') + '\n');
      const line = JSON.stringify(row) + '\n';
      buffer.push(line); bytes += Buffer.byteLength(line); rows++;
      if (buffer.length >= 2000) await flush();
    },
    flush,
    get rows() { return rows; },
    async close() { await flush(); await data.close(); await index.close(); },
  };
}

/** Reads one page (PAGE_ROWS rows) of a result table by position. */
export async function readResultPage(workspaceId, runId, set, page) {
  const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
  const index = await open(indexFile(workspaceId, runId, set), 'r').catch(() => null);
  if (!index) return [];
  try {
    const entry = Buffer.alloc(OFFSET_WIDTH * 2);
    const { bytesRead } = await index.read(entry, 0, entry.length, (pageNumber - 1) * OFFSET_WIDTH);
    if (bytesRead < OFFSET_WIDTH) return [];
    const start = Number(entry.subarray(0, OFFSET_WIDTH - 1).toString());
    const data = await open(dataFile(workspaceId, runId, set), 'r');
    try {
      const end = bytesRead >= OFFSET_WIDTH * 2 ? Number(entry.subarray(OFFSET_WIDTH, OFFSET_WIDTH * 2 - 1).toString()) : (await data.stat()).size;
      const chunk = Buffer.alloc(Math.max(0, end - start));
      await data.read(chunk, 0, chunk.length, start);
      // A page still being written may end mid-line; keep complete rows only.
      return chunk.toString('utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(0, PAGE_ROWS);
    } finally { await data.close(); }
  } finally { await index.close(); }
}

/** Streams every row of a result table, in order. */
export async function* resultRows(workspaceId, runId, set) {
  const stream = createReadStream(dataFile(workspaceId, runId, set), { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

/** Removes finished runs older than the retention period that no saved report uses. */
export async function pruneRuns(workspaceId, keepIds, maxAgeMs = 7 * 24 * 3600 * 1000) {
  const dir = path.join(root, workspaceId);
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!uuid.test(name) || keepIds.has(name)) continue;
    const run = await readRun(workspaceId, name).catch(() => null);
    if (run && ['queued', 'running'].includes(run.status)) continue;
    if (run && Date.now() - (run.finishedAt || run.createdAt || 0) < maxAgeMs) continue;
    await rm(path.join(dir, name), { recursive: true, force: true });
  }
}
