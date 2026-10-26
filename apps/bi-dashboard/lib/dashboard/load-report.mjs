/**
 * Load a report with bounded waiting and actionable HTTP errors.
 * @param {string} id
 * @param {{ signal?: AbortSignal, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export async function loadReport(id, { signal, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(`/api/reports/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' });
    if (response.status === 401) throw new Error('Please sign in again to open this report.');
    if (response.status === 404) return { report: null, siblingReports: [] };
    if (!response.ok) throw new Error('The report could not be loaded. Please retry.');
    const body = await response.json();
    if (!body || !Object.hasOwn(body, 'report') || (body.report !== null && (typeof body.report !== 'object' || Array.isArray(body.report)))) {
      throw new Error('The server returned an incomplete report. Please retry.');
    }
    return body;
  } catch (error) {
    if (timedOut) throw new Error('Loading the report took too long. Check the connection and retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
