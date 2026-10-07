// ============================================================================
// Generic semantic-layer query tool, backing the query_semantic_layer MCP
// tool named in the project's own architecture doc. This is the ONE place
// the chat agent can ask for any measure/dimension/date-range/filter
// combination across the real ISP cubes (cube/model/isp.yml), instead of
// a hand-written JS function + MCP tool per individual question.
//
// This is still NOT a raw-SQL escape hatch: the shape of what can be
// asked is entirely bounded by Cube's query JSON (measures/dimensions/
// filters/timeDimensions, each validated against the real cube/model/isp.yml
// catalog by Cube itself) -- Cube rejects anything referencing a
// measure/dimension that doesn't exist in that model, and compiles
// everything else into SQL itself. The LLM never writes SQL at any point.
// ============================================================================

import jwt from 'jsonwebtoken';
import { CUBE_CATALOG, validateCubeQuery } from '../semantic/cubeCatalog.mjs';
import { validateQueryJoins, needsValueGrounding, getValueDictionary, groundQuery } from '../semantic/valueGrounding.mjs';

const inFlight = new Map();

export function recordCountQuery(query) {
  if (query.measures?.length || query.timeDimensions?.some((t) => t.granularity)) return null;
  const cube = CUBE_CATALOG.find((c) => c.dimensions.some((d) => d.primaryKey && query.dimensions?.includes(d.name)));
  if (!cube || !query.dimensions.every((d) => d.startsWith(`${cube.name}.`))) return null;
  const count = cube.measures.find((m) => m.type === 'count' && !m.name.endsWith('.active_customer_count'));
  if (!count) return null;
  const measures = new Set(CUBE_CATALOG.flatMap((c) => c.measures.map((m) => m.name)));
  const hasMeasureFilter = (filters) => (filters ?? []).some((f) => f.and || f.or ? hasMeasureFilter(f.and ?? f.or) : measures.has(f.member));
  if (hasMeasureFilter(query.filters)) return null;
  return { measures: [count.name], filters: query.filters ?? [], timeDimensions: query.timeDimensions ?? [] };
}

export async function loadCubeQuery(query, endpoint = 'load') {
  if (!['load', 'sql'].includes(endpoint)) throw new Error('Invalid Cube operation.');
  validateCubeQuery(query);
  validateQueryJoins(query);
  const apiUrl = process.env.CUBEJS_API_URL;
  if (!apiUrl) throw new Error('CUBEJS_API_URL is not configured.');
  const key = `${endpoint}:${JSON.stringify(query)}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = (async () => {
    const deadline = Date.now() + 90000;
    while (true) {
      const res = await fetch(`${apiUrl}/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: signCubeToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, ...(endpoint === 'load' ? { cache: 'no-cache' } : {}) }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const body = await res.json();
      if (body?.error === 'Continue wait' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (!res.ok || body?.error) throw new Error(body?.error || `Cube query failed with status ${res.status}`);
      return body;
    }
  })();
  inFlight.set(key, request);
  try { return await request; } finally { inFlight.delete(key); }
}

function signCubeToken() {
  const secret = process.env.CUBEJS_API_SECRET;
  if (!secret) {
    throw new Error('CUBEJS_API_SECRET is not configured (needed to call the Cube semantic layer).');
  }
  // No securityContext/row-level claims yet -- matches this project's
  // current, documented state: RLS via Cube queryRewrite from a JWT is a
  // flagged future step, not wired in yet (see cube/README.md).
  return jwt.sign({}, secret, { expiresIn: '5m' });
}

export async function querySemanticLayer(cubeQuery) {
  if (needsValueGrounding(cubeQuery)) cubeQuery = groundQuery(cubeQuery, await getValueDictionary());
  const body = await loadCubeQuery(cubeQuery);
  return body?.data ?? [];
}

/**
 * NEW 2026-10-04: one page of a Cube query plus the TRUE total row count
 * (Cube's own `total: true`), so semantic-layer reports page through every
 * row like every other report instead of stopping at whatever `limit` the
 * first query happened to use. `maxRows` (optional) caps the reachable
 * total for a genuine top-N query.
 */
export async function querySemanticLayerPage(cubeQuery, { offset = 0, limit = 100, maxRows } = {}) {
  if (needsValueGrounding(cubeQuery)) cubeQuery = groundQuery(cubeQuery, await getValueDictionary());
  const apiUrl = process.env.CUBEJS_API_URL;
  if (!apiUrl) throw new Error('CUBEJS_API_URL is not configured.');
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  let safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 5000));
  if (Number.isFinite(maxRows)) safeLimit = Math.max(0, Math.min(safeLimit, maxRows - safeOffset));
  if (safeLimit === 0) return { rows: [], total: Number(maxRows) || 0 };
  const { limit: _ignored, offset: _ignored2, ...base } = cubeQuery ?? {};
  const order = { ...(base.order ?? {}) };
  if (!Object.keys(order).length) {
    const time = base.timeDimensions?.find((t) => t.granularity)?.dimension;
    if (time) order[time] = 'asc';
    else if (base.measures?.length) order[base.measures[0]] = 'desc';
  }
  // Tie-break groups/records consistently so adjacent pages do not drift.
  for (const dimension of base.dimensions ?? []) if (!order[dimension]) order[dimension] = 'asc';
  const countQuery = recordCountQuery(base);
  const query = { ...base, ...(Object.keys(order).length ? { order } : {}), limit: safeLimit, offset: safeOffset, ...(countQuery ? {} : { total: true }) };
  // A primary-key record list has exactly one row per source record.
  // Count its filtered population separately instead of grouping every wide row.
  const [body, countBody] = await Promise.all([loadCubeQuery(query), countQuery ? loadCubeQuery(countQuery) : Promise.resolve(null)]);
  const countValue = countBody?.data?.[0]?.[countQuery?.measures[0]];
  if (countQuery && (countValue == null || !Number.isFinite(Number(countValue)))) throw new Error('The database did not return a valid record count; no empty result has been inferred.');
  const rawTotal = countQuery ? Number(countValue) : typeof body?.total === 'number' ? body.total : (body?.data ?? []).length;
  const total = Number.isFinite(maxRows) ? Math.min(rawTotal, maxRows) : rawTotal;
  return { rows: body?.data ?? [], total };
}
