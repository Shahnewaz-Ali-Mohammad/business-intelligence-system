import { discoverDatabase } from './connectors.mjs';

// Reading a database's structure takes seconds on large SQL Servers. Chat,
// paging, graphs, exports, schedules and the designer reuse it for a minute.
// Every caller still compares the fingerprint with the approved tool, so a
// schema change is caught at most a minute later.
const TTL = 60000;
const hits = new Map();
const pending = new Map();

export async function cachedCatalog(sourceId, config) {
  const hit = hits.get(sourceId);
  if (hit && Date.now() - hit.at < TTL) return hit.catalog;
  let loading = pending.get(sourceId);
  if (!loading) { loading = discoverDatabase(config); pending.set(sourceId, loading); }
  try {
    const catalog = await loading;
    hits.set(sourceId, { at: Date.now(), catalog });
    return catalog;
  } finally {
    if (pending.get(sourceId) === loading) pending.delete(sourceId);
  }
}

/** Forget a source's cached structure (after setup changes). */
export function forgetCatalog(sourceId) { hits.delete(sourceId); }
