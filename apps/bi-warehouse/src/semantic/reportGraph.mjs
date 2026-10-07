import { parse, toSql } from 'pgsql-ast-parser';
import { quote } from './warehouseModel.mjs';

export const GRAPH_KINDS = ['bar', 'line', 'kpi', 'histogram', 'scatter', 'density'];
export function graphOptions(catalog, source) {
  const rootName = (source.measures?.[0] || source.dimensions?.[0] || source.timeDimensions?.[0]?.dimension)?.split('.')[0];
  const root = catalog.find((c) => c.name === rootName);
  if (!root) throw new Error('This report has no graphable query.');
  const measureNames = new Set(catalog.flatMap((c) => c.measures.map((m) => m.name)));
  const measureFilter = (fs) => (fs || []).some((f) => measureNames.has(f.member) || measureFilter(f.and || f.or));
  const fixedGrouping = measureFilter(source.filters);
  // A modeled join is not a returned report column. Filter/order members and
  // date-range-only fields constrain the report but are not graph choices.
  const selected = new Set([...(source.dimensions ?? []), ...(source.timeDimensions ?? []).filter((t) => t.granularity).map((t) => t.dimension)]);
  const dimensions = catalog.flatMap((c) => c.dimensions).filter((d) => selected.has(d.name));
  const named = (f) => ({ ...f, title: f.title || f.name.split('.').slice(1).join(' ').replaceAll('_', ' '), table: catalog.find((c) => c.name === f.name.split('.')[0])?.table || f.name.split('.')[0] });
  const rootCount = root.measures.find((m) => m.type === 'count' && !/active_customer_count$/.test(m.name));
  const measures = catalog.flatMap((c) => c.measures).filter((m) => source.measures?.includes(m.name)).map(named);
  if (!fixedGrouping && rootCount && !measures.some((m) => m.name === rootCount.name)) measures.push({ ...named(rootCount), title: `${named(rootCount).title} (computed)` });
  const identifier = (d) => d.primaryKey || /(?:id|sk|snid)$/i.test(d.title || d.name);
  const categories = dimensions.filter((d) => fixedGrouping && source.dimensions?.includes(d.name) || ['string', 'boolean'].includes(d.type) || d.type === 'number' && identifier(d)).map(named);
  const times = dimensions.filter((d) => d.type === 'time').map(named);
  const numerics = dimensions.filter((d) => d.type === 'number' && !identifier(d)).map(named);
  const columns = [...dimensions.map(named), ...measures.filter((m) => source.measures?.includes(m.name))];
  const count = rootCount?.name;
  const defaultMeasure = source.measures?.[0] || count || measures[0]?.name;
  const selectedCategories = categories.filter((d) => source.dimensions?.includes(d.name) && !identifier(d));
  const defaultCategory = (selectedCategories.length === 1 && source.dimensions?.length === 1 ? selectedCategories[0]?.name : undefined) || selectedCategories.find((d) => /status|type|category/i.test(d.title))?.name || selectedCategories.find((d) => /name/i.test(d.title))?.name || selectedCategories[0]?.name || categories[0]?.name;
  const defaultTime = times.find((d) => source.timeDimensions?.some((t) => t.dimension === d.name))?.name || times[0]?.name;
  const fixedGranularity = source.timeDimensions?.find((t) => t.granularity)?.granularity;
  const kinds = fixedGrouping ? (categories.length ? ['bar'] : fixedGranularity ? ['line'] : ['kpi']) : [...(measures.length ? ['kpi'] : []), ...(categories.length && measures.length ? ['bar'] : []), ...(times.length && measures.length ? ['line'] : []), ...(numerics.length && count ? ['histogram'] : []), ...(numerics.length > 1 && count ? ['scatter', 'density'] : [])];
  return { root: rootName, columns, measures, categories, times, numerics, count, kinds, defaultMeasure, defaultCategory, defaultTime, fixedGrouping, fixedGranularity };
}

export function defaultGraph(options, source) {
  const time = source.timeDimensions?.find((t) => t.granularity);
  const kind = time && options.kinds.includes('line') ? 'line' : !source.dimensions?.length && source.measures?.length ? 'kpi' : options.defaultCategory ? 'bar' : options.numerics.length ? 'histogram' : 'kpi';
  return { version: 1, kind, title: 'Report visualization', measure: options.defaultMeasure, dimension: options.defaultCategory, time: options.defaultTime, x: options.numerics[0]?.name, y: options.numerics[1]?.name, granularity: time?.granularity || 'month', offset: 0, pageSize: 50, search: '', direction: 'desc', filters: [] };
}

export function normalizeGraph(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid graph settings.');
  if (!options.kinds.includes(input.kind)) throw new Error('This data does not support that graph style.');
  if (options.fixedGrouping && input.kind === 'line' && input.granularity !== options.fixedGranularity) throw new Error('Preserve the report interval so aggregate thresholds keep their meaning.');
  const has = (set, name) => set.some((f) => f.name === name);
  if (!['histogram', 'scatter', 'density'].includes(input.kind) && !has(options.measures, input.measure)) throw new Error('Select an approved metric.');
  if (input.kind === 'bar' && !has(options.categories, input.dimension)) throw new Error('Select an approved category.');
  if (input.kind === 'line' && !has(options.times, input.time)) throw new Error('Select an approved date field.');
  if (['histogram', 'scatter', 'density'].includes(input.kind) && (!has(options.numerics, input.x) || !options.count)) throw new Error('Select an approved numeric field.');
  if (['scatter', 'density'].includes(input.kind) && (!has(options.numerics, input.y) || input.x === input.y)) throw new Error('Select two different numeric fields.');
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid graph page.');
  const pageSize = input.pageSize ?? 50;
  if (![20, 50, 100].includes(pageSize)) throw new Error('Invalid graph page size.');
  if (!Number.isSafeInteger(offset + pageSize)) throw new Error('Invalid graph page.');
  if (!['hour', 'day', 'week', 'month', 'quarter', 'year'].includes(input.granularity || 'month')) throw new Error('Invalid time interval.');
  if (typeof (input.search ?? '') !== 'string' || (input.search?.length ?? 0) > 100) throw new Error('Invalid category search.');
  const filters = input.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 10 || filters.some((f) => !f || !has(options.categories, f.member) || !['equals', 'notSet'].includes(f.operator) || !Array.isArray(f.values) || f.values.length > 1 || f.values.some((v) => typeof v !== 'string' || v.length > 1000) || f.operator === 'equals' && f.values.length !== 1)) throw new Error('Invalid graph filter.');
  return { version: 1, kind: input.kind, title: typeof input.title === 'string' ? input.title.slice(0, 160) : 'Report visualization', measure: has(options.measures, input.measure) ? input.measure : options.defaultMeasure, dimension: has(options.categories, input.dimension) ? input.dimension : options.defaultCategory, time: has(options.times, input.time) ? input.time : options.defaultTime, x: has(options.numerics, input.x) ? input.x : options.numerics[0]?.name, y: has(options.numerics, input.y) ? input.y : options.numerics[1]?.name, granularity: input.granularity || 'month', offset, pageSize, search: '', direction: input.direction === 'asc' ? 'asc' : 'desc', filters };
}

export function graphQuery(source, spec, options) {
  const filters = [...(source.filters ?? []), ...spec.filters];
  if (options.fixedGrouping) {
    const { limit: _limit, offset: _offset, total: _total, ...base } = source;
    return { ...base, filters, order: spec.kind === 'bar' ? { [spec.measure]: spec.direction, ...Object.fromEntries((source.dimensions || []).map((d) => [d, 'asc'])) } : source.order || {} };
  }
  const timeDimensions = (source.timeDimensions ?? []).map(({ dimension, dateRange }) => ({ dimension, ...(dateRange ? { dateRange } : {}) }));
  if (spec.kind === 'line') {
    const time = timeDimensions.find((t) => t.dimension === spec.time);
    if (time) time.granularity = spec.granularity;
    else timeDimensions.push({ dimension: spec.time, granularity: spec.granularity });
  }
  const numeric = ['histogram', 'scatter', 'density'].includes(spec.kind);
  return { measures: [numeric ? options.count : spec.measure], dimensions: spec.kind === 'bar' ? [spec.dimension] : numeric ? [spec.x, ...(spec.kind !== 'histogram' ? [spec.y] : [])] : [], filters, timeDimensions, order: spec.kind === 'bar' ? { [spec.measure]: spec.direction, [spec.dimension]: 'asc' } : spec.kind === 'line' ? { [spec.time]: 'asc' } : {}, timezone: source.timezone || 'Asia/Dhaka' };
}

// Only trusted Cube-generated SQL enters this function. Remove its outer
// preview cap through the AST; nested model limits and predicates stay intact.
export function uncappedCubeSql(body) {
  const sql = body?.sql;
  if (!sql || !Array.isArray(sql.sql) || typeof sql.sql[0] !== 'string' || !Array.isArray(sql.sql[1]) || sql.external) throw new Error('Distribution query cannot run on this data source.');
  const statements = parse(sql.sql[0]);
  if (statements.length !== 1 || statements[0].type !== 'select') throw new Error('Unsupported distribution query.');
  const ast = statements[0];
  delete ast.limit; delete ast.orderBy;
  if (!sql.aliasNameToMember) throw new Error('Cube did not supply verified field aliases.');
  return { text: toSql.statement(ast), values: sql.sql[1], aliases: sql.aliasNameToMember };
}

export function distributionSql(compiled, spec, count) {
  const alias = (member) => { const name = Object.keys(compiled.aliases).find((k) => compiled.aliases[k] === member); if (!name) throw new Error('Graph field alias unavailable.'); return quote(name); };
  const x = alias(spec.x), y = spec.kind === 'histogram' ? null : alias(spec.y), weight = alias(count);
  const dimensions = y ? 2 : 1, bins = 20;
  const bucket = (field, lo, hi) => `CASE WHEN ${hi}=${lo} THEN 0 ELSE LEAST(${bins - 1},FLOOR((${field}-${lo})/NULLIF(${hi}-${lo},0)*${bins}))::int END`;
  const xy = y ? `,${y}::numeric AS y` : '';
  const stats = y ? ',min(y) AS ymin,max(y) AS ymax' : '';
  const valid = y ? ' AND y IS NOT NULL' : '';
  const exact = spec.kind === 'scatter' ? ",'points',(SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM (SELECT x::text,y::text,weight::text AS value FROM points WHERE x IS NOT NULL AND y IS NOT NULL ORDER BY x,y LIMIT 201) p)" : '';
  const sql = `WITH source AS (${compiled.text}), points AS (SELECT ${x}::numeric AS x${xy},${weight}::numeric AS weight FROM source), stats AS (SELECT min(x) AS xmin,max(x) AS xmax${stats},COALESCE(sum(weight),0) AS population,sum(weight) FILTER (WHERE x IS NOT NULL${valid}) AS included FROM points), bins AS (SELECT ${bucket('x', 'xmin', 'xmax')} AS bx${y ? `,${bucket('y', 'ymin', 'ymax')} AS by` : ''},sum(weight)::text AS value FROM points CROSS JOIN stats WHERE x IS NOT NULL${valid} GROUP BY 1${y ? ',2' : ''}) SELECT jsonb_build_object('population',population::text,'included',COALESCE(included,0)::text,'xmin',xmin::text,'xmax',xmax::text${y ? ",'ymin',ymin::text,'ymax',ymax::text" : ''},'bins',${bins},'dimensions',${dimensions},'rows',COALESCE((SELECT jsonb_agg(to_jsonb(bins) ORDER BY bx${y ? ',by' : ''}) FROM bins),'[]'::jsonb)${exact}) AS result FROM stats`;
  return { text: sql, values: compiled.values };
}
