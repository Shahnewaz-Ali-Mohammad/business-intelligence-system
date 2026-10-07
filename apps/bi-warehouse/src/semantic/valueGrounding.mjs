import { getWarehousePool } from '../config/db.mjs';
import { CUBE_CATALOG, validateCubeQuery } from './cubeCatalog.mjs';

const references = [
  { cube: 'IspTicketType', table: 'dim_ticket_type', id: 'ticket_type_id', name: 'ticket_type_name' },
  { cube: 'IspStatus', table: 'dim_status', id: 'status_id', name: 'status_name' },
  { cube: 'IspDepartment', table: 'dim_department', id: 'department_id', name: 'department_name' },
  { cube: 'IspPop', table: 'dim_pop', id: 'pop_id', name: 'pop_name' },
  { cube: 'IspPackage', table: 'dim_package', id: 'package_id', name: 'package_name' },
];
const codedFields = [
  { member: 'IspCustomer.connection_type', table: 'dim_customer', column: 'connection_type' },
  { member: 'IspCustomer.resident_type', table: 'dim_customer', column: 'resident_type' },
  { member: 'IspTicket.status', table: 'fact_ticket', column: 'status' },
  { member: 'IspCollection.tran_mode_id', table: 'fact_collection', column: 'tran_mode_id' },
  { member: 'IspCollection.tran_mode_name', table: 'fact_collection', column: 'tran_mode_name' },
  { member: 'IspCustomerLifecycleEvent.event_type', table: 'fact_customer_lifecycle_event', column: 'event_type' },
];
let cached;
let pending;

export async function getValueDictionary() {
  if (cached && Date.now() - cached.at < 60000) return cached.data;
  if (pending) return pending;
  pending = (async () => {
    const pool = getWarehousePool();
    const groups = await Promise.all(references.map(async (ref) => {
      // Identifiers come only from this fixed whitelist, never from user/model text.
      const { rows } = await pool.query(`SELECT ${ref.id} AS id, ${ref.name} AS name FROM ${ref.table} ORDER BY ${ref.id}`);
      return { ...ref, values: rows.map((r) => ({ id: String(r.id), name: r.name == null ? null : String(r.name) })) };
    }));
    const codes = await Promise.all(codedFields.map(async (field) => {
      const { rows } = await pool.query(`SELECT DISTINCT ${field.column} AS value FROM ${field.table} WHERE ${field.column} IS NOT NULL LIMIT 101`);
      return { member: field.member, values: rows.map((r) => String(r.value)), complete: rows.length < 101 };
    }));
    const data = { groups, codes };
    cached = { at: Date.now(), data };
    return data;
  })();
  try { return await pending; } finally { pending = null; }
}

const normalized = (value) => String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const oneEditApart = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

export function ticketTerms(dictionary, message) {
  const group = dictionary.groups.find((g) => g.cube === 'IspTicketType');
  if (!group || !/\bti(?:ck|k|c)ets?\b/i.test(message) || /\b(connection\s+type|customer\s+connection|customers?\s+(?:with|using|on))\b/i.test(message)) return [];
  const found = new Map();
  let remaining = ` ${normalized(message)} `;
  // Resolve complete labels first, so Packet Loss does not become three
  // different categories sharing the words packet/loss.
  for (const row of [...group.values].filter((r) => r.name).sort((a, b) => b.name.length - a.name.length)) {
    const phrase = ` ${normalized(row.name)} `;
    if (remaining.includes(phrase)) {
      found.set(row.id, row);
      remaining = remaining.replaceAll(phrase, ' ');
    }
  }
  const requestWords = new Set(['need', 'want', 'required', 'show', 'give', 'list', 'report', 'reports', 'ticket', 'tickets', 'tikets', 'category', 'categories', 'details', 'detail', 'full', 'complete', 'every', 'available', 'column', 'columns', 'count', 'many', 'whose', 'which', 'where', 'with', 'that', 'those', 'them', 'their', 'from', 'between', 'opened', 'equal', 'equals', 'include', 'including', 'please', 'records', 'record', 'only', 'mean', 'after', 'before', 'name', 'names', 'specific', 'choose', 'filter', 'filters']);
  for (const word of remaining.split(' ').filter((w) => w.length >= 4 && /\p{L}/u.test(w) && !requestWords.has(w))) {
    let matches = matchReference(group, word);
    if (!matches.length) matches = group.values.filter((r) => r.name && normalized(r.name).split(' ').some((w) => w.length >= 4 && oneEditApart(word, w)));
    if (matches.length === 1) found.set(matches[0].id, matches[0]);
  }
  return [...found.values()];
}
export function matchReference(group, value) {
  const text = normalized(value);
  const exact = group.values.filter((r) => r.id === String(value) || (r.name && normalized(r.name) === text));
  if (exact.length) return exact;
  if (!text) return [];
  const words = text.split(' ');
  return group.values.filter((r) => r.name && words.every((word) => normalized(r.name).split(' ').includes(word)));
}

export function dictionaryContext(dictionary, message) {
  const words = new Set(normalized(message).split(' ').filter((w) => w.length >= 3));
  const groups = dictionary.groups.map((g) => ({
    member: `${g.cube}.${g.name}`, idMember: `${g.cube}.${g.id}`,
    values: ['IspPop', 'IspPackage'].includes(g.cube)
      ? g.values.filter((r) => r.name && normalized(r.name).split(' ').some((w) => words.has(w))).slice(0, 30)
      : g.values,
  }));
  return JSON.stringify({ referenceCategories: groups, codedFields: dictionary.codes, matchedTicketTerms: ticketTerms(dictionary, message) });
}

export class QueryGroundingError extends Error {}

export function repairExplicitCategoryAlternatives(query, dictionary, message) {
  const result = structuredClone(query);
  if (!/\bor\b/i.test(message)) return result;
  const ids = new Set(ticketTerms(dictionary, message).map((r) => r.id));
  function visit(items) {
    for (const f of items ?? []) {
      if (f.and || f.or) visit(f.and ?? f.or);
      else if (['IspTicket.ticket_type_id', 'IspTicketType.ticket_type_id'].includes(f.member)
        && ids.size >= 2 && f.operator === 'inDateRange' && f.values?.length === ids.size && f.values.every((v) => ids.has(v))) f.operator = 'equals';
      else if (f.operator === 'inDateRange' && /_id$/.test(f.member) && f.values?.length >= 2) {
        const phrase = f.member.split('.').at(-1).split('_').join('[\\s_]*');
        if (f.values.every((value) => new RegExp(`\\b${phrase}\\s+(?:(?:equals?|is)\\s+)?${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(message))) f.operator = 'equals';
      }
    }
  }
  visit(result.filters);
  return result;
}

export function needsValueGrounding(query) {
  return (query.filters ?? []).some((f) => f.and || f.or ? needsValueGrounding({ filters: f.and ?? f.or })
    : ['equals', 'notEquals', 'contains', 'notContains'].includes(f.operator)
      && (f.values ?? []).some((v) => !/^-?\d+$/.test(String(v)))
      && (codedFields.some((c) => c.member === f.member) || references.some((r) => f.member.endsWith(`.${r.id}`) || f.member === `${r.cube}.${r.name}`)));
}

export function groundQuery(query, dictionary, message = '') {
  validateCubeQuery(query);
  const result = structuredClone(query);
  const roots = new Set([...(query.measures ?? []), ...(query.dimensions ?? []), ...(query.timeDimensions ?? []).map((t) => t.dimension)].map((m) => m.split('.')[0]));
  const ticketQuestion = roots.has('IspTicket') && /\btickets?\b/i.test(message);
  const explicitConnection = /\b(connection|connection_type|connected|customers?\s+(?:with|using|on))\b/i.test(message);
  const clarification = (member, value, choices) => {
    const options = choices.length ? ` Possible matches: ${choices.slice(0, 6).map((r) => `${r.name} (ID ${r.id})`).join(', ')}.` : '';
    throw new QueryGroundingError(`I could not uniquely match "${value}" to ${member.split('.').at(-1).replaceAll('_', ' ')}.${options} Please specify the category name or ID; I have not run a guessed filter.`);
  };
  function visit(filters) {
    return (filters ?? []).map((filter) => {
      if (filter.and) return { and: visit(filter.and) };
      if (filter.or) return { or: visit(filter.or) };
      if (!['equals', 'notEquals', 'contains', 'notContains'].includes(filter.operator)) return filter;
      let member = filter.member;
      if (member === 'IspCustomer.connection_type' && ticketQuestion && !explicitConnection) {
        const mentioned = new Map(ticketTerms(dictionary, message).map((row) => [row.id, row]));
        if (mentioned.size === 1) return { ...filter, member: 'IspTicket.ticket_type_id', operator: ['notEquals', 'notContains'].includes(filter.operator) ? 'notEquals' : 'equals', values: [...mentioned.keys()] };
        if (mentioned.size > 1) clarification('IspTicket.ticket_type_id', filter.values?.join(', '), [...mentioned.values()]);
      }
      let group = dictionary.groups.find((g) => member.endsWith(`.${g.id}`) || member === `${g.cube}.${g.name}`);
      const values = [];
      for (const value of filter.values ?? []) {
        const coded = dictionary.codes.find((c) => c.member === member);
        const actualCode = coded?.values.find((v) => normalized(v) === normalized(value));
        if (coded && actualCode != null) { values.push(actualCode); continue; }
        if (coded && /^-?\d+$/.test(String(value))) { values.push(String(value)); continue; }
        if (coded && !coded.values.includes(String(value))) {
          const typeGroup = dictionary.groups.find((g) => g.cube === 'IspTicketType');
          const types = typeGroup ? matchReference(typeGroup, value) : [];
          if (member === 'IspCustomer.connection_type' && ticketQuestion && !explicitConnection && types.length === 1) {
            member = 'IspTicket.ticket_type_id';
            group = typeGroup;
          } else if (coded.complete) throw new QueryGroundingError(`The database stores ${member.split('.').at(-1).replaceAll('_', ' ')} as ${coded.values.length ? `values ${coded.values.slice(0, 20).join(', ')}` : 'no populated values'}. I do not have a verified mapping from "${value}" to this field. Please specify a stored value or the intended category; I have not run a guessed filter.`);
        }
        if (!group) { values.push(String(value)); continue; }
        // Numeric reference IDs are literal lookups, including nonexistent IDs.
        if (/^-?\d+$/.test(String(value)) && member.endsWith(`.${group.id}`)) { values.push(String(value)); continue; }
        const matches = matchReference(group, value);
        const sameLabel = matches.length > 0 && matches.every((r) => normalized(r.name) === normalized(value));
        if (matches.length !== 1 && !sameLabel && ['equals', 'notEquals'].includes(filter.operator)) clarification(member, value, matches);
        if (['contains', 'notContains'].includes(filter.operator) && member === `${group.cube}.${group.name}`) { values.push(String(value)); continue; }
        if (!matches.length) clarification(member, value, []);
        values.push(...matches.map((r) => member.endsWith(`.${group.id}`) ? r.id : r.name));
      }
      return { ...filter, member, values: [...new Set(values)], operator: group && member.endsWith(`.${group.id}`) && ['equals', 'notEquals', 'contains', 'notContains'].includes(filter.operator) ? (['notEquals', 'notContains'].includes(filter.operator) ? 'notEquals' : 'equals') : filter.operator };
    });
  }
  result.filters = visit(query.filters);
  const selectedCubes = [...roots];
  // Explicit schema-field equality is a literal instruction, not a category hint.
  for (const match of message.matchAll(/\b([a-z][a-z0-9_]*(?:_id|_sk|_snid))\s+(?:equal\s+to|equals?|=|is)\s+(-?\d+)\b/gi)) {
    const candidates = CUBE_CATALOG.filter((c) => selectedCubes.includes(c.name)).flatMap((c) => c.dimensions).filter((d) => d.name.endsWith(`.${match[1].toLowerCase()}`));
    if (candidates.length !== 1) continue;
    const member = candidates[0].name;
    const hasMember = (items) => items.some((f) => f.and || f.or ? hasMember(f.and ?? f.or) : f.member === member);
    const matchesLiteral = (items) => items.some((f) => f.and || f.or ? matchesLiteral(f.and ?? f.or) : f.member === member && f.operator === 'equals' && f.values?.length === 1 && f.values[0] === match[2]);
    if (!hasMember(result.filters) || !matchesLiteral(result.filters)) throw new QueryGroundingError(`The query must preserve the explicit literal filter ${member} equals ${match[2]}. Do not substitute a different category or identifier.`);
  }
  if (!/\b(except|exclude|excluding|without|not|other)\b/i.test(message)) {
    const aliases = { customer: 'customer_id', ticket: 'source_ticket_id', billing: 'billing_sk', collection: 'collection_sk', refund: 'refund_sk', adjustment: 'adjustment_sk', pop: 'pop_id', package: 'package_id' };
    for (const match of message.matchAll(/\b(customer|ticket|billing|collection|refund|adjustment|pop|package)\s+id\s+([\w-]+)\b/gi)) {
      if (/^(?:and|or|where|with|only|name|names|details|is|equals?|by|not|null|for|columns?)$/i.test(match[2])) continue;
      const field = aliases[match[1].toLowerCase()];
      const hasExact = (items) => items.some((f) => f.and || f.or ? hasExact(f.and ?? f.or) : f.member?.endsWith(`.${field}`) && f.operator === 'equals' && f.values?.includes(match[2]));
      if (!hasExact(result.filters)) throw new QueryGroundingError(`Preserve the user's literal ${match[1]} ID ${match[2]} as an exact ${field} filter. Do not substitute or omit the identifier.`);
    }
  }
  const primary = query.measures?.[0]?.split('.')[0] || query.dimensions?.[0]?.split('.')[0];
  const fields = CUBE_CATALOG.filter((c) => roots.has(c.name)).flatMap((c) => c.dimensions);
  const flat = (filters) => (filters || []).flatMap((f) => f.and || f.or ? flat(f.and || f.or) : [f]);
  for (const field of fields) {
    const tokens = field.name.split('.').at(-1).split('_');
    const phrase = tokens.join('[\\s_]*');
    const aliases = fields.filter((f) => f.name.split('.').at(-1) === tokens.join('_'));
    if (aliases.length > 1 && !field.name.startsWith(`${primary}.`)) continue;
    const matches = [...message.matchAll(new RegExp(`\\b${phrase}\\s+(?:is\\s+)?(not\\s+null|null)\\b`, 'gi'))];
    const populated = new RegExp(`\\bpopulated\\s+${phrase}\\b|\\b${phrase}\\s+(?:is\\s+)?not\\s+(?:empty|blank)\\b|\\b${phrase}\\s+(?:is\\s+)?not\\s+null\\s+and\\s+(?:is\\s+)?not\\s+(?:empty|blank)\\b`, 'i').test(message);
    if (!matches.length && !populated) continue;
    const predicates = flat(result.filters).filter((f) => f.member === field.name && ['set', 'notSet'].includes(f.operator));
    const requested = new Set(matches.map((m) => /^not/i.test(m[1]) ? 'set' : 'notSet'));
    if (populated && !requested.size) requested.add('set');
    if (populated && !/\bor\b/i.test(message)) {
      if (!predicates.length) { const p = { member: field.name, operator: 'set', values: [] }; result.filters.push(p); predicates.push(p); }
      const emptyChecks = flat(result.filters).filter((f) => f.member === field.name && ['equals', 'notEquals'].includes(f.operator) && f.values?.length === 1 && f.values[0] === '');
      if (emptyChecks.length) for (const p of emptyChecks) p.operator = 'notEquals';
      else result.filters.push({ member: field.name, operator: 'notEquals', values: [''] });
    }
    if (!predicates.length || requested.size > 1 && ![...requested].every((op) => predicates.some((f) => f.operator === op))) throw new QueryGroundingError(`Preserve the explicit null predicate for ${field.name}. set means IS NOT NULL; notSet means IS NULL. No literal ID is required.`);
    if (requested.size === 1) for (const predicate of predicates) { predicate.operator = [...requested][0]; predicate.values = []; }
  }
  const mentioned = ticketTerms(dictionary, message);
  const hasCategoryFilter = (items) => items.some((f) => f.and || f.or ? hasCategoryFilter(f.and ?? f.or) : ['IspTicket.ticket_type_id', 'IspTicketType.ticket_type_id', 'IspTicketType.ticket_type_name'].includes(f.member));
  const allTypes = /\b(?:all|every)\s+(?:(?:ticket\s+)?(?:types?|categor(?:y|ies))|types?\s+of\s+tickets)\b/i.test(message);
  const explicitTypeId = /\bticket_type_id\b|\bticket\s+(?:type|category)\s+id\b/i.test(message);
  if (ticketQuestion && allTypes && !mentioned.length && !explicitTypeId && hasCategoryFilter(result.filters)) {
    throw new QueryGroundingError('The user requested all ticket types. Remove the inherited or inferred ticket category filter; preserve other requested filters and return the requested columns.');
  }
  if (roots.has('IspTicket') && mentioned.length === 1 && !explicitConnection && !hasCategoryFilter(result.filters)
      && !/\b(compare|versus|except|exclude|excluding|without|not|other)\b/i.test(message)) {
    throw new QueryGroundingError(`The request names the actual ticket category ${mentioned[0].name} (ID ${mentioned[0].id}), but the query dropped its filter. Include the category filter; do not return all categories.`);
  }
  validateQueryJoins(result);
  return validateCubeQuery(result);
}

export function validateQueryJoins(query) {
  const all = new Set([...(query.measures ?? []), ...(query.dimensions ?? []), ...(query.timeDimensions ?? []).map((t) => t.dimension), ...Object.keys(query.order ?? {})].map((m) => m.split('.')[0]));
  function visit(filters) { for (const f of filters ?? []) { if (f.and || f.or) visit(f.and ?? f.or); else all.add(f.member.split('.')[0]); } }
  visit(query.filters);
  // Only a root and its many-to-one dimensions can be combined safely.
  const safeRoot = [...all].some((root) => {
    const reachable = new Set([root]);
    for (const name of reachable) for (const join of CUBE_CATALOG.find((c) => c.name === name)?.joins ?? []) if (join.relationship === 'many_to_one') reachable.add(join.name);
    return [...all].every((name) => reachable.has(name));
  });
  if (!safeRoot) throw new QueryGroundingError('These fields span tables without a safe modeled join. Please separate the requested metrics or specify the relationship; I will not combine facts in a way that can multiply totals.');
}
