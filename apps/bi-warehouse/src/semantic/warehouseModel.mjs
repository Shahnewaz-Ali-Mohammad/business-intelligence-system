import crypto from 'node:crypto';
import { dump, load } from 'js-yaml';

export const quote = (s) => `"${String(s).replaceAll('"', '""')}"`;
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').toLowerCase().split(' ');
export const sensitiveTable = (s) => words(s).some((w) => ['password', 'passwords', 'token', 'tokens', 'otp', 'otps', 'auth', 'authentication', 'session', 'sessions', 'credential', 'credentials', 'login', 'logins'].includes(w));
export const sensitiveColumn = (s) => /password|passwd|pwd|(?:mk|user|router)pass$|token|secret|credential|otp|national.?id|^nid$|passport|credit.?card|card.?number|cvv|api.?key|private.?key|access.?key|security.?stamp|email|phone|mobile|cell.?no|contact.?number|address|^dob$|birth/i.test(s);
export function fieldType(column) {
  const t = column.dataType;
  if (/^(date|timestamp|timestamp with time zone|timestamp without time zone)$/.test(t)) return 'time';
  if (t === 'boolean') return 'boolean';
  if (/^(smallint|integer|bigint|numeric|real|double precision)$/.test(t)) return /(?:id|snid|sk)$/i.test(column.name) || column.isPrimaryKey ? 'string' : 'number';
  if (/^(text|character varying|character|uuid|USER-DEFINED)$/.test(t)) return 'string';
  return null;
}
export function safeColumns(table) {
  return table.columns.filter((c) => !sensitiveColumn(c.name) && fieldType(c));
}
function memberName(s) {
  return `f_${s.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 16)}_${hash(s).slice(0, 6)}`;
}

export function buildWarehouseModel(discovery, workspaceId, selectedTables, approvedJoins = []) {
  if (!/^[a-f0-9-]{36}$/i.test(workspaceId)) throw new Error('Invalid workspace.');
  if (!Array.isArray(selectedTables) || !selectedTables.length || selectedTables.length > 250) throw new Error('Select between 1 and 250 tables.');
  if (!Array.isArray(approvedJoins) || approvedJoins.length > 250) throw new Error('Too many relationships.');
  const selected = new Set(selectedTables);
  if (selected.size !== selectedTables.length) throw new Error('Duplicate table selection.');
  const tables = discovery.tables.filter((t) => selected.has(t.key));
  if (tables.length !== selected.size || tables.some((t) => sensitiveTable(t.name))) throw new Error('Unavailable or restricted table.');
  const cubes = tables.map((t) => {
    // Cube builds SQL aliases from both names. Keep the combined alias below
    // PostgreSQL's 63-byte limit, including measure/date grouping suffixes.
    const name = `w${hash(workspaceId).slice(0, 6)}_${t.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 12)}_${hash(t.key).slice(0, 6)}`;
    const fields = safeColumns(t);
    if (!fields.length) throw new Error(`No approved fields in ${t.name}.`);
    // Cube needs one primary-key expression for a composite key, not multiple
    // independently unique dimensions. JSON preserves nulls and separators.
    const pk = fields.filter((f) => f.isPrimaryKey);
    const completePk = pk.length > 0 && pk.length === t.columns.filter((f) => f.isPrimaryKey).length;
    const dimensions = fields.map((f) => ({ name: memberName(f.name), title: f.name, sql: `{CUBE}.${quote(f.name)}${fieldType(f) === 'string' && /int|numeric/.test(f.dataType) ? '::text' : ''}`, type: fieldType(f), public: true, ...(completePk && pk.length === 1 && f.isPrimaryKey ? { primary_key: true } : {}), meta: { column: f.name } }));
    if (completePk && pk.length > 1) dimensions.push({ name: 'record_key', sql: `jsonb_build_array(${pk.map((f) => `{CUBE}.${quote(f.name)}`).join(', ')})::text`, type: 'string', primary_key: true, public: false });
    const measures = [{ name: 'record_count', title: `${t.name} record count`, type: 'count' }];
    for (const f of fields.filter((c) => fieldType(c) === 'number')) for (const type of ['sum', 'avg', 'min', 'max']) measures.push({ name: `${type}_${memberName(f.name)}`, title: `${type} of ${f.name}`, sql: `{CUBE}.${quote(f.name)}`, type });
    return { name, sql_table: `${quote(t.schema)}.${quote(t.name)}`, measures, dimensions, joins: [], meta: { table_key: t.key, source_tables: [t.key], stable_records: completePk } };
  });
  const byTable = new Map(cubes.map((c) => [c.meta.table_key, c]));
  const available = [...discovery.joins, ...discovery.candidates.filter((j) => approvedJoins.includes(j.id))];
  if (approvedJoins.some((id) => !discovery.candidates.some((j) => j.id === id))) throw new Error('Unknown proposed relationship.');
  const warnings = [];
  for (const j of available) {
    const from = byTable.get(j.from), to = byTable.get(j.to);
    if (!from || !to || from === to) continue;
    if (!from.meta.stable_records || !to.meta.stable_records) { warnings.push(`Relationship ${j.id} omitted: a usable primary key is required on both tables for safe joined metrics.`); continue; }
    const fromTable = tables.find((t) => t.key === j.from), toTable = tables.find((t) => t.key === j.to);
    if (!j.columns.every((p) => safeColumns(fromTable).some((f) => f.name === p.from) && safeColumns(toTable).some((f) => f.name === p.to))) continue;
    const targetPk = toTable.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (!targetPk.length || targetPk.length !== j.columns.length || !targetPk.every((c) => j.columns.some((p) => p.to === c))) { warnings.push(`Relationship ${j.id} omitted: target primary key is not established.`); continue; }
    // Multiple roles to one target (creator/assignee, for example) require
    // separate aliases. Do not silently pick one of those relationships.
    if (available.filter((other) => other.from === j.from && other.to === j.to).length > 1) { warnings.push(`Multiple relationships from ${j.from} to ${j.to} require separate roles; not activated.`); continue; }
    from.joins.push({ name: to.name, relationship: 'many_to_one', sql: j.columns.map((p) => `{CUBE}.${quote(p.from)} = {${to.name}}.${quote(p.to)}`).join(' AND ') });
  }
  for (const t of tables) if (!cubes.find((c) => c.meta.table_key === t.key).meta.stable_records) warnings.push(`${t.key}: no usable primary key; distinct-value exploration is available, but exact row-list pagination is not guaranteed.`);
  const model = { version: 1, workspaceId, schemas: discovery.schemas, selectedTables, approvedJoins, schemaFingerprint: discovery.fingerprint, connectionFingerprint: discovery.connectionFingerprint, cubes, warnings: [...new Set(warnings)] };
  model.fingerprint = hash(model);
  return model;
}
export function serializeModel(model) { return dump({ warehouseModel: model }); }
export function parseModel(yaml) {
  const model = load(yaml)?.warehouseModel;
  if (model?.version !== 1 || !Array.isArray(model.cubes) || !model.cubes.length) throw new Error('This warehouse has not been activated.');
  const { fingerprint, ...base } = model;
  if (fingerprint !== hash(base)) throw new Error('Invalid warehouse model fingerprint.');
  return model;
}
export function cubeYaml(model) { return dump({ cubes: model.cubes }); }
export function modelCatalog(model) {
  return model.cubes.map((c) => ({ name: c.name, table: c.meta.table_key, stableRecords: c.meta.stable_records, joins: c.joins.map((j) => ({ name: j.name, relationship: j.relationship })), measures: c.measures.map((m) => ({ name: `${c.name}.${m.name}`, title: m.title, type: m.type })), dimensions: c.dimensions.filter((d) => d.public !== false).map((d) => ({ name: `${c.name}.${d.name}`, title: d.title, type: d.type, primaryKey: !!d.primary_key })) }));
}
export function validateWarehouseQuery(model, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A structured query is required.');
  const allowed = new Set(['measures', 'dimensions', 'filters', 'timeDimensions', 'order', 'limit', 'offset', 'total', 'timezone']);
  if (Object.keys(input).some((k) => !allowed.has(k))) throw new Error('Unsupported query option.');
  const catalog = modelCatalog(model), fields = new Map(catalog.flatMap((c) => [...c.dimensions.map((d) => [d.name, { ...d, kind: 'dimension' }]), ...c.measures.map((m) => [m.name, { ...m, type: 'number', kind: 'measure' }])]));
  const used = new Set();
  const field = (name, kind) => { const f = fields.get(name); if (!f || kind && f.kind !== kind) throw new Error(`Unavailable field: ${name}`); used.add(name.split('.')[0]); return f; };
  const measures = input.measures ?? [], dimensions = input.dimensions ?? [];
  if (!Array.isArray(measures) || !Array.isArray(dimensions) || measures.length > 30 || dimensions.length > 200) throw new Error('Too many selected fields.');
  for (const m of measures) field(m, 'measure');
  for (const d of dimensions) field(d, 'dimension');
  if (!measures.length && !dimensions.length && !input.timeDimensions?.some((t) => t.granularity)) throw new Error('Select a metric or field.');
  let filterCount = 0;
  const checkFilters = (filters, depth = 0) => {
    if (!Array.isArray(filters) || depth > 8) throw new Error('Invalid filters.');
    for (const f of filters) {
      if (++filterCount > 100) throw new Error('Too many filters.');
      if (f.and || f.or) { if (Object.keys(f).length !== 1) throw new Error('Invalid filter group.'); checkFilters(f.and ?? f.or, depth + 1); continue; }
      const type = field(f.member).type;
      if (!['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'set', 'notSet', 'gt', 'gte', 'lt', 'lte', 'inDateRange', 'beforeDate', 'afterDate'].includes(f.operator)) throw new Error('Unsupported filter operator.');
      if (['inDateRange', 'beforeDate', 'afterDate'].includes(f.operator) && type !== 'time') throw new Error('Date filters require a date field.');
      if (['contains', 'notContains', 'startsWith', 'endsWith'].includes(f.operator) && type !== 'string') throw new Error('Text filters require a text field.');
      if (['gt', 'gte', 'lt', 'lte'].includes(f.operator) && type !== 'number') throw new Error('Numeric filters require a numeric field.');
      if (!['set', 'notSet'].includes(f.operator) && (!Array.isArray(f.values) || !f.values.length || f.values.length > 200 || f.values.some((v) => typeof v !== 'string' || v.length > 1000))) throw new Error('Invalid filter values.');
      if (type === 'number' && (f.values ?? []).some((v) => !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))) throw new Error('Numeric filters require numeric values.');
      if (['inDateRange', 'beforeDate', 'afterDate'].includes(f.operator) && ((f.operator === 'inDateRange' ? f.values.length !== 2 : f.values.length !== 1) || f.values.some((v) => !/^\d{4}-\d{2}-\d{2}(?:T[\d:.Z+-]+)?$/.test(v)))) throw new Error('Use explicit date filter boundaries.');
    }
  };
  checkFilters(input.filters ?? []);
  if (!Array.isArray(input.timeDimensions ?? []) || (input.timeDimensions?.length ?? 0) > 10) throw new Error('Invalid date grouping.');
  for (const t of input.timeDimensions ?? []) {
    if (field(t.dimension, 'dimension').type !== 'time') throw new Error('Date grouping requires a date field.');
    if (t.granularity && !['hour', 'day', 'week', 'month', 'quarter', 'year'].includes(t.granularity)) throw new Error('Unsupported date grouping.');
    if (t.dateRange && (!Array.isArray(t.dateRange) || t.dateRange.length !== 2 || t.dateRange.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.Z+-]+)?$/.test(d)))) throw new Error('Use explicit start and end dates.');
  }
  if (!input.order || typeof input.order === 'object' && !Array.isArray(input.order)) {
    for (const [name, direction] of Object.entries(input.order ?? {})) { field(name); if (!['asc', 'desc'].includes(direction)) throw new Error('Invalid ordering.'); }
  } else throw new Error('Invalid ordering.');
  const roots = [...used].filter((r) => { const reached = new Set([r]); for (const name of reached) for (const j of catalog.find((c) => c.name === name)?.joins ?? []) reached.add(j.name); return [...used].every((n) => reached.has(n)); });
  if (!roots.length) throw new Error('No approved relationship connects the requested tables. Ask for relationship review; do not guess a join.');
  if (new Set(measures.map((m) => m.split('.')[0])).size > 1) throw new Error('Metrics from multiple table grains must be queried separately to prevent duplicate counts.');
  const metricRoot = measures[0]?.split('.')[0];
  if (metricRoot && !roots.includes(metricRoot)) throw new Error('Metric grain cannot safely reach the requested fields.');
  for (const k of ['limit', 'offset']) if (input[k] != null && (!Number.isSafeInteger(input[k]) || input[k] < 0 || k === 'limit' && input[k] > 5000)) throw new Error('Invalid page bounds.');
  return { ...input, timezone: 'Asia/Dhaka' };
}
