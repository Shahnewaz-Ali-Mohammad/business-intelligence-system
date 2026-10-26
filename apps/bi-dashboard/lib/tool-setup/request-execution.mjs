// Request-local only: never reuse database results across users or replies.
export function executeOnce(cache, key, execute) {
  if (cache.has(key)) return cache.get(key);
  const pending = Promise.resolve().then(execute).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}
