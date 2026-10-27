import { AsyncLocalStorage } from 'node:async_hooks';

// Every query against a business database runs on behalf of a signed-in
// person (or a scheduled run acting for its owner). Access is decided per
// workspace before a request gets here; this is the last check that a query
// never runs without a person behind it.

const store = new AsyncLocalStorage();

export class AccessDenied extends Error {
  constructor(message) { super(message); this.name = 'AccessDenied'; }
}

/** Sets the person for the rest of the current request. */
export function enterAccess(access) { store.enterWith(access); }
/** Runs `fn` for a person (chat runs, scheduled runs, background work). */
export function runWithAccess(access, fn) { return store.run(access, fn); }
export function currentAccess() { return store.getStore() || null; }

/** Called by the connectors before every business query. */
export async function scopeForQuery(_config, _definition, _catalog, parameters) {
  const access = currentAccess();
  if (!access) throw new AccessDenied('This query has no signed-in user, so it was not run.');
  if (!access.dataRole && !access.allData && !access.setupPreview) throw new AccessDenied('Your role does not include viewing business data.');
  return parameters;
}
