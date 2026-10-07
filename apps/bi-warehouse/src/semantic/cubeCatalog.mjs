import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

export function loadCubeCatalog() {
  const candidates = [process.env.CUBE_MODEL_PATH, resolve(process.cwd(), 'cube/model/isp.yml'), resolve(process.cwd(), '../../cube/model/isp.yml')].filter(Boolean);
  const modelPath = candidates.find((path) => existsSync(path));
  if (!modelPath) throw new Error('Cube model not found. Set CUBE_MODEL_PATH to the deployed isp.yml file.');
  const model = load(readFileSync(modelPath, 'utf8'));
  return model.cubes.map((cube) => ({
    name: cube.name,
    table: cube.sql_table ?? cube.meta?.table ?? null,
    sourceTables: cube.meta?.source_tables ?? [cube.sql_table],
    joins: (cube.joins ?? []).map((join) => ({ name: join.name, relationship: join.relationship })),
    measures: (cube.measures ?? []).map((m) => ({ name: `${cube.name}.${m.name}`, type: m.type })),
    dimensions: (cube.dimensions ?? []).map((d) => ({ name: `${cube.name}.${d.name}`, type: d.type, primaryKey: Boolean(d.primary_key) })),
  }));
}

export const CUBE_CATALOG = loadCubeCatalog();
export const CUBE_CATALOG_TEXT = CUBE_CATALOG.map((cube) =>
  `${cube.name} (${cube.table || `derived from ${cube.sourceTables.join(', ')}`}): measures ${cube.measures.map((m) => m.name).join(', ')}; dimensions ${cube.dimensions.map((d) => `${d.name}:${d.type}`).join(', ')}; joins ${cube.joins.map((j) => `${j.name} (${j.relationship})`).join(', ') || 'none'}`,
).join('\n');

export function tablesForCubeQuery(query) {
  const names = new Set([...(query.measures ?? []), ...(query.dimensions ?? []), ...(query.timeDimensions ?? []).map((t) => t.dimension)].map((m) => m.split('.')[0]));
  function visit(filters) {
    for (const filter of filters ?? []) {
      if (filter.and || filter.or) visit(filter.and ?? filter.or);
      else names.add(filter.member.split('.')[0]);
    }
  }
  visit(query.filters);
  return [...new Set(CUBE_CATALOG.filter((c) => names.has(c.name)).flatMap((c) => c.sourceTables))];
}

const members = new Map(CUBE_CATALOG.flatMap((cube) => [...cube.measures, ...cube.dimensions].map((m) => [m.name, m])));
export function normalizeCubeQuery(input) {
  const explicit = [...(input.measures ?? []), ...(input.dimensions ?? [])].filter((m) => members.has(m));
  const preferred = explicit.find((m) => CUBE_CATALOG.some((c) => c.measures.some((measure) => measure.name === m)))?.split('.')[0] || explicit[0]?.split('.')[0];
  function resolveMember(name) {
    if (members.has(name)) return name;
    if (typeof name !== 'string') throw new Error(`Unknown Cube field: ${name}`);
    const canonical = (value) => value.toLowerCase().replace(/[\s_]/g, '');
    const candidates = [...members.keys()].filter((m) => name.includes('.') ? canonical(m) === canonical(name) : canonical(m.split('.').at(-1)) === canonical(name));
    if (candidates.length === 1) return candidates[0];
    const preferredMember = candidates.find((m) => m.startsWith(`${preferred}.`));
    if (preferredMember) return preferredMember;
    throw new Error(`Ambiguous Cube field: ${name}. Use its full cube name.`);
  }
  const measures = [];
  const dimensions = [...(input.dimensions ?? [])].map(resolveMember);
  for (const name of input.measures ?? []) {
    const member = resolveMember(name);
    if (CUBE_CATALOG.some((c) => c.measures.some((m) => m.name === member))) measures.push(member);
    else dimensions.push(member);
  }
  function filters(items) {
    return (items ?? []).map((f) => f.and ? { and: filters(f.and) } : f.or ? { or: filters(f.or) } : { ...f, member: resolveMember(f.member ?? f.dimension), dimension: undefined });
  }
  const query = { ...input, measures, dimensions: [...new Set(dimensions)], filters: filters(input.filters),
    timeDimensions: (input.timeDimensions ?? []).map((t) => ({ dimension: resolveMember(t.dimension), ...(t.dateRange ? { dateRange: t.dateRange } : {}), ...(t.granularity ? { granularity: t.granularity } : {}) })),
    order: Object.fromEntries((Array.isArray(input.order) ? input.order.map((o) => [o.member, o.direction]) : Object.entries(input.order ?? {})).map(([name, direction]) => [resolveMember(name), direction])),
  };
  if (query.limit == null) delete query.limit;
  return validateCubeQuery(query);
}

export function questionCatalogFields(question) {
  const words = String(question).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const compact = ` ${words} `;
  return CUBE_CATALOG.flatMap((c) => [...c.dimensions, ...c.measures]).filter((f) => {
    const field = f.name.split('.').at(-1).replaceAll('_', ' ');
    return compact.includes(` ${field} `) || compact.includes(` ${field.replaceAll(' ', '')} `);
  }).map((f) => f.name);
}

export function simpleCatalogRequest(question) {
  const text = String(question).trim().replace(/[.?!]+$/, '');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const cube of CUBE_CATALOG) {
    if (!cube.dimensions.some((f) => f.primaryKey)) continue;
    const noun = cube.name.replace(/^Isp/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    for (const field of cube.dimensions) {
      const phrase = field.name.split('.').at(-1).split('_').map(escape).join('[\\s_]*');
      const group = text.match(new RegExp(`^(?:please\\s+)?count\\s+${escape(noun)}s?\\s+(?:grouped\\s+)?by\\s+${phrase}$`, 'i'));
      const record = text.match(new RegExp(`^(?:please\\s+)?(?:show|list|show me|give me)\\s+(?:all\\s+)?${escape(noun)}s?\\s+(?:whose|where|with)\\s+${phrase}\\s+(?:is\\s+(not\\s+null|null)|(?:equals?|equal to|=)\\s+([\\w-]+))$`, 'i'));
      if (!group && !record) continue;
      // Typed numeric/date/boolean values need the planner's type checks.
      if (record?.[2] && field.type !== 'string') continue;
      const count = cube.measures.find((m) => m.type === 'count');
      if (group && !count) continue;
      const query = group ? { measures: [count.name], dimensions: [field.name], filters: [] }
        : { measures: [], dimensions: cube.dimensions.map((f) => f.name), filters: [{ member: field.name, operator: record[1] ? /^not/i.test(record[1]) ? 'set' : 'notSet' : 'equals', values: record[1] ? [] : [record[2]] }] };
      const titleCase = (value) => value.replace(/\b\w+/g, (word) => /^(id|sk)$/i.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
      return { title: titleCase(group ? `${noun} count by ${field.name.split('.').at(-1).replaceAll('_', ' ')}` : `${noun} records by ${field.name.split('.').at(-1).replaceAll('_', ' ')}`), query: validateCubeQuery(query) };
    }
  }
  return null;
}

export function validateCubeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('A Cube query object is required.');
  if (!(query.measures?.length || query.dimensions?.length || query.timeDimensions?.some((t) => t.granularity))) {
    throw new Error('Select at least one measure or dimension.');
  }
  const names = [...(query.measures ?? []), ...(query.dimensions ?? []), ...Object.keys(query.order ?? {})];
  function filterNames(filters) {
    for (const filter of filters ?? []) {
      if (filter.and || filter.or) filterNames(filter.and ?? filter.or);
      else {
        names.push(filter.member);
        if (['inDateRange', 'beforeDate', 'afterDate'].includes(filter.operator) && members.get(filter.member)?.type !== 'time') throw new Error(`Date operator ${filter.operator} cannot filter ${filter.member}; use equals with multiple values for category alternatives.`);
      }
    }
  }
  filterNames(query.filters);
  for (const t of query.timeDimensions ?? []) {
    names.push(t.dimension);
    if (members.get(t.dimension)?.type !== 'time') throw new Error(`Not a time dimension: ${t.dimension}`);
  }
  for (const name of names) if (!members.has(name)) throw new Error(`Unknown Cube field: ${name}`);
  for (const name of query.measures ?? []) {
    if (!CUBE_CATALOG.some((c) => c.measures.some((m) => m.name === name))) throw new Error(`Not a measure: ${name}`);
  }
  for (const name of query.dimensions ?? []) {
    if (!CUBE_CATALOG.some((c) => c.dimensions.some((d) => d.name === name))) throw new Error(`Not a dimension: ${name}`);
  }
  return query;
}
