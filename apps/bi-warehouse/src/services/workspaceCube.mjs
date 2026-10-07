import jwt from 'jsonwebtoken';
import { modelCatalog, validateWarehouseQuery } from '../semantic/warehouseModel.mjs';

export function signWorkspaceToken(workspaceId, ownerUserId, modelVersion, purpose = 'query', preview = false) {
  if (!process.env.CUBEJS_API_SECRET) throw new Error('Cube API secret is not configured.');
  return jwt.sign({ workspaceId, ownerUserId, modelVersion, purpose, preview }, process.env.CUBEJS_API_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}
export function verifyWorkspaceToken(token) {
  const claims = jwt.verify(token, process.env.CUBEJS_API_SECRET, { algorithms: ['HS256'] });
  if (typeof claims !== 'object' || !/^[a-f0-9-]{36}$/i.test(claims.workspaceId) || !Number.isSafeInteger(claims.ownerUserId) || !/^[a-f0-9]{64}$/.test(claims.modelVersion)) throw new Error('Invalid warehouse authorization.');
  return claims;
}
export async function workspaceCubeLoad(context, query, endpoint = 'load') {
  if (!['load', 'meta', 'sql'].includes(endpoint)) throw new Error('Invalid Cube operation.');
  if (endpoint !== 'meta') query = validateWarehouseQuery(context.model, query);
  const url = process.env.CUBEJS_API_URL;
  if (!url) throw new Error('Cube API is not configured.');
  const token = signWorkspaceToken(context.model.workspaceId, context.ownerUserId, context.model.fingerprint, 'query', !!context.preview);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    // Live reports must not reuse a pre-refresh result while summaries read
    // newer source rows. Cube's no-cache mode also waits for fresh execution.
    const res = await fetch(`${url}/${endpoint}`, { method: endpoint === 'meta' ? 'GET' : 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, ...(endpoint === 'meta' ? {} : { body: JSON.stringify({ query, ...(endpoint === 'load' ? { cache: 'no-cache' } : {}) }) }), signal: context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal });
    const body = await res.json();
    if (body.error === 'Continue wait') { await new Promise((r) => setTimeout(r, 250)); continue; }
    if (!res.ok || body.error) throw new Error('The warehouse query could not be executed. Check the connection or approved model; no empty result has been inferred.');
    return body;
  }
  throw new Error('Warehouse query timed out.');
}
/** @param {any} context @param {any} query @param {{offset?: number, limit?: number, maxRows?: number}} options */
export async function workspaceCubePage(context, query, { offset = 0, limit = 100, maxRows } = {}) {
  validateWarehouseQuery(context.model, query);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid page bounds.');
  if (maxRows != null && (!Number.isSafeInteger(maxRows) || maxRows < 1)) throw new Error('Invalid top-N limit.');
  const { limit: _limit, offset: _offset, total: _total, ...base } = query;
  const catalog = modelCatalog(context.model);
  const root = catalog.find((c) => base.dimensions?.some((d) => d.startsWith(`${c.name}.`)) && c.stableRecords);
  const recordList = !base.measures?.length && !base.timeDimensions?.some((t) => t.granularity) && root && base.dimensions?.every((d) => d.startsWith(`${root.name}.`)) && root.dimensions.some((d) => d.primaryKey && base.dimensions.includes(d.name));
  const order = { ...(base.order ?? {}) };
  for (const d of base.dimensions ?? []) if (!order[d]) order[d] = 'asc';
  for (const t of base.timeDimensions ?? []) if (t.granularity && !order[t.dimension]) order[t.dimension] = 'asc';
  const safeLimit = maxRows ? Math.max(0, Math.min(limit, maxRows - offset)) : limit;
  if (!safeLimit) return { rows: [], total: maxRows };
  const body = await workspaceCubeLoad(context, { ...base, order, offset, limit: safeLimit, ...(recordList ? {} : { total: true }) });
  let total = body.total;
  if (recordList) {
    const count = `${root.name}.record_count`;
    const result = await workspaceCubeLoad(context, { measures: [count], filters: base.filters ?? [], timeDimensions: base.timeDimensions ?? [] });
    total = Number(result.data?.[0]?.[count]);
  }
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('The warehouse did not return a valid total count.');
  return { rows: body.data ?? [], total: maxRows ? Math.min(total, maxRows) : total };
}
