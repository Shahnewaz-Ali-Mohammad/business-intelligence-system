import { AsyncLocalStorage } from 'node:async_hooks';

// Every query against a business database runs inside an access scope: who
// is asking, which departments they cover and whether they see everything.
// The scope is set once per request (or per scheduled run) and checked where
// queries are compiled, so chat, report pages, exports, graphs and schedules
// are all filtered the same way. A query with no scope is refused.

const store = new AsyncLocalStorage();

export class AccessDenied extends Error {
  constructor(message) { super(message); this.name = 'AccessDenied'; }
}

/** Sets the scope for the rest of the current request. */
export function enterAccess(access) { store.enterWith(access); }
/** Runs `fn` with a scope (scheduled runs, background work). */
export function runWithAccess(access, fn) { return store.run(access, fn); }
export function currentAccess() { return store.getStore() || null; }

const objectOf = (field) => String(field).slice(0, String(field).indexOf(':') < 0 ? undefined : String(field).indexOf(':'));
function whereFieldList(node, out = [], depth = 0) {
  if (!node || depth > 10) return out;
  if (node.field) out.push(node.field);
  for (const child of node.and || node.or || (node.not ? [node.not] : [])) whereFieldList(child, out, depth + 1);
  return out;
}

/** Every table a query can read: the tool's own fields plus the plan's. */
export function tablesUsed(definition, plan = {}) {
  const fields = [
    ...(definition.columns || []), ...(definition.groupBy || []),
    ...(definition.metrics || []).map((m) => m.field), ...(definition.filters || []).map((f) => f.field),
    ...(Array.isArray(plan.columns) ? plan.columns : []), ...(plan.groupBy || []),
    ...(plan.metrics || []).flatMap((m) => [m.field, ...whereFieldList(m.where)]),
    ...whereFieldList(plan.where), ...(plan.dateGroups || []).map((g) => g.field),
    ...(plan.sort || []).map((s) => s.field).filter((f) => String(f).includes(':')),
  ].filter(Boolean);
  return [...new Set([definition.base, ...fields.map(objectOf)].filter(Boolean))];
}

const label = (catalog, id) => catalog?.objects?.find((o) => o.id === id)?.name || id;

/**
 * Applies the data access policy to one tool call and returns the
 * parameters to run. Throws AccessDenied when the person may not see it.
 *   policy.tables[objectId]    'department' | 'shared' | 'restricted'
 *   policy.departmentField     the field holding a record's department
 *   policy.departmentValues    { [departmentId]: [stored values] }
 */
export function scopeToolParameters({ definition, catalog, parameters = {}, access, policy }) {
  if (!access) throw new AccessDenied('Sign in to view data.');
  if (access.allData) return parameters;
  if (access.setupPreview) return parameters;
  if (!access.dataRole) throw new AccessDenied('Your role does not include viewing business data.');
  if (!policy) throw new AccessDenied('Your admin has not set up department access for this database yet.');

  const capability = !!definition.capabilities && typeof parameters.query === 'string';
  const plan = capability ? JSON.parse(parameters.query || '{}') : {};
  const tables = tablesUsed(definition, plan);
  const blocked = tables.filter((id) => !['department', 'shared'].includes(policy.tables?.[id]));
  if (blocked.length) throw new AccessDenied(`This needs ${blocked.map((id) => label(catalog, id)).join(', ')}, which your role cannot view. Ask your admin if you need it.`);
  if (!tables.some((id) => policy.tables?.[id] === 'department')) return parameters;

  const values = [...new Set((access.departmentIds || []).flatMap((id) => policy.departmentValues?.[String(id)] || []).map(String))];
  if (!values.length) throw new AccessDenied('No data in this database is assigned to your department yet.');
  if (values.length > 100) throw new AccessDenied('Your department covers too many values to filter safely. Ask your admin to simplify the mapping.');
  if (!capability) throw new AccessDenied('This saved report cannot be filtered by department yet. Ask the question in chat instead.');
  if (!policy.departmentField || !definition.capabilities.fields?.includes(policy.departmentField))
    throw new AccessDenied(`${label(catalog, definition.base)} cannot be filtered by department, so your role cannot view it.`);

  const filter = { field: policy.departmentField, operator: 'in', value: values };
  const scoped = { ...plan, where: plan.where ? { and: [plan.where, filter] } : filter };
  return { ...parameters, query: JSON.stringify(scoped) };
}

/** A stored procedure for this person: forced department value, or refused. */
export function scopeProcedureValues({ procedure, values, access, policy }) {
  if (!access) throw new AccessDenied('Sign in to run reports.');
  if (access.allData) return values;
  if (!access.dataRole) throw new AccessDenied('Your role does not include viewing business data.');
  const rule = policy?.procedures?.[String(procedure.id)];
  if (!rule?.parameter) throw new AccessDenied('This stored procedure is available to the CEO only, because it cannot be filtered by department.');
  const own = [...new Set((access.departmentIds || []).flatMap((id) => policy.departmentValues?.[String(id)] || []).map(String))];
  if (own.length !== 1) throw new AccessDenied('This stored procedure takes one department; your access covers ' + (own.length ? 'several' : 'none') + '.');
  return { ...values, [rule.parameter]: own[0] };
}

/**
 * Called by the connectors before every business query: applies the
 * current request's scope (set by requireAccess or a scheduled run).
 */
export async function scopeForQuery(config, definition, catalog, parameters) {
  const access = currentAccess();
  if (!access) throw new AccessDenied('This query has no signed-in user, so it was not run.');
  const policy = access.allData || access.setupPreview ? null : await access.policyFor?.(config);
  return scopeToolParameters({ definition, catalog, parameters, access, policy });
}
