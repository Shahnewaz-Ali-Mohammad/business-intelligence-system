import { quote } from './warehouseModel.mjs';
import { uncappedCubeSql } from './reportGraph.mjs';

export function summaryPlan(catalog, query) {
  const root = catalog.find((c) => c.name === (query.measures?.[0] || query.dimensions?.[0] || query.timeDimensions?.[0]?.dimension)?.split('.')[0]);
  const fields = catalog.flatMap((c) => [...c.dimensions, ...c.measures].map((f) => ({ ...f, title: f.title || f.name.split('.').at(-1).replaceAll('_', ' ') })));
  const dimensions = [...(query.dimensions ?? [])];
  if (!query.measures?.length) {
    for (const join of (root?.joins || []).filter((j) => j.relationship === 'many_to_one').slice(0, 8)) {
      const target = catalog.find((c) => c.name === join.name);
      if (!target || !/status|type|category|department|pop|package/i.test(target.table || target.name)) continue;
      const label = target.dimensions.find((f) => f.type === 'string' && /name|label/i.test(f.title || f.name));
      if (label && !dimensions.includes(label.name)) dimensions.push(label.name);
    }
  }
  const selected = [...(query.measures ?? []), ...dimensions, ...(query.timeDimensions ?? []).filter((t) => t.granularity).map((t) => `${t.dimension}.${t.granularity}`)];
  const field = (name) => fields.find((f) => f.name === name || f.type === 'time' && name.startsWith(`${f.name}.`));
  const identifiers = (f) => f.primaryKey || /(?:id|sk|snid)$/i.test(f.title || f.name);
  const measureNames = new Set(catalog.flatMap((c) => c.measures.map((m) => m.name)));
  const measureFilter = (filters) => (filters || []).some((f) => measureNames.has(f.member) || measureFilter(f.and || f.or));
  const grouped = Boolean(query.measures?.length) || measureFilter(query.filters);
  const count = root?.measures.find((m) => m.type === 'count' && !/active_customer_count$/.test(m.name))?.name;
  const numeric = selected.filter((name) => { const f = field(name); return f && !identifiers(f) && (query.measures?.includes(name) || f.type === 'number'); }).map((name) => ({ name, title: field(name).title, additive: !grouped || ['sum', 'count'].includes(field(name).type) }));
  const dates = selected.filter((name) => field(name)?.type === 'time');
  const categories = selected.filter((name) => { const f = field(name); return f && ['string', 'boolean'].includes(f.type) && (grouped || !identifiers(f)) && !/customer.?name|subject|description|notes?|email|phone|address/i.test(f.title); });
  // Record counts supply exact multiplicities, so unused row-detail fields
  // need not be materialized. Aggregate/HAVING queries retain their grain.
  const summaryDimensions = !grouped && count ? dimensions.filter((name) => numeric.slice(0, 8).some((f) => f.name === name) || dates.slice(0, 2).includes(name) || categories.slice(0, 3).includes(name)) : dimensions;
  return { grouped, count: grouped ? null : count, numeric: numeric.slice(0, 8), dates: dates.slice(0, 2), categories: categories.slice(0, 3), omitted: [...numeric.slice(8).map((f) => f.name), ...dates.slice(2), ...categories.slice(3)], query: { ...query, order: {}, dimensions: summaryDimensions, ...(!grouped && count ? { measures: [count] } : {}) } };
}

export function summarySql(body, plan) {
  const compiled = uncappedCubeSql(body);
  const alias = (name) => {
    const key = Object.keys(compiled.aliases).find((k) => compiled.aliases[k] === name);
    if (!key) throw new Error(`Summary field alias unavailable: ${name}`);
    return quote(key);
  };
  const weight = plan.count ? `${alias(plan.count)}::numeric` : '1::numeric';
  const entries = plan.numeric.map((f) => {
    const x = alias(f.name);
    const labels = [...plan.categories, ...plan.dates].slice(0, 3);
    const share = f.additive ? `,CASE WHEN (SELECT min(${x})>=0 AND sum(${x})>0 FROM source) THEN round(${x}::numeric/(SELECT sum(${x}) FROM source)*100,2)::text END AS "percentageOfMetricTotal"` : '';
    const ranked = (direction) => `(SELECT COALESCE(jsonb_agg(v),'[]'::jsonb) FROM (SELECT ${x}::text AS value,(count(*) OVER (PARTITION BY ${x}))::text AS "tiedGroupCount",jsonb_build_object(${labels.flatMap((name) => [literal(name), `${alias(name)}::text`]).join(',')}) AS labels${share} FROM source WHERE ${x} IS NOT NULL ORDER BY ${x} ${direction} LIMIT 3) v)`;
    const leaders = plan.grouped && labels.length ? `'highestGroups',${ranked('DESC')},'lowestGroups',${ranked('ASC')}` : `'highestGroups','[]'::jsonb,'lowestGroups','[]'::jsonb`;
    return `jsonb_build_object('member',${literal(f.name)},'title',${literal(f.title)},${leaders},'statistics',(WITH vals AS (SELECT ${x}::numeric AS x,${weight} AS w FROM source), valid AS (SELECT x,sum(w) AS w FROM vals WHERE x IS NOT NULL GROUP BY x), ordered AS (SELECT x,w,sum(w) OVER (ORDER BY x ROWS UNBOUNDED PRECEDING) AS upto FROM valid), stats AS (SELECT sum(w) AS n,sum(x*w) AS total,min(x) AS low,max(x) AS high,sum(x*x*w) AS squares FROM valid) SELECT jsonb_build_object('count',COALESCE(n,0)::text,'missing',(SELECT COALESCE(sum(w) FILTER (WHERE x IS NULL),0)::text FROM vals),'minimum',low::text,'maximum',high::text,'average',(total/NULLIF(n,0))::text,'median',(SELECT ((min(x) FILTER (WHERE upto>=ceil(n/2)))+(min(x) FILTER (WHERE upto>=floor(n/2)+1)))/2 FROM ordered)::text,'standardDeviation',(CASE WHEN n>0 THEN sqrt(GREATEST(squares/n-power(total/n,2),0)) END)::text,'zeroCount',(SELECT COALESCE(sum(w) FILTER (WHERE x=0),0)::text FROM vals),'negativeCount',(SELECT COALESCE(sum(w) FILTER (WHERE x<0),0)::text FROM vals)${f.additive ? ",'sum',total::text" : ''}) FROM stats))`;
  });
  // Frequencies of result groups are not shares of the measured records.
  // Grouped reports use metric-weighted shares on their ranked examples.
  const groups = (plan.grouped ? [] : plan.categories).map((name) => {
    const x = alias(name);
    return `jsonb_build_object('member',${literal(name)},'breakdown',(WITH groups AS (SELECT ${x}::text AS label,sum(${weight}) AS n FROM source GROUP BY 1), stats AS (SELECT sum(n) AS total,count(*) AS groups FROM groups) SELECT jsonb_build_object('distinctGroups',groups,'missing',(SELECT COALESCE(sum(n) FILTER (WHERE label IS NULL),0)::text FROM groups),'highest',(SELECT COALESCE(jsonb_agg(v),'[]'::jsonb) FROM (SELECT label,n::text AS count,round(n/NULLIF(total,0)*100,2)::text AS percentage FROM groups ORDER BY n DESC,label NULLS LAST LIMIT 5) v),'lowest',(SELECT COALESCE(jsonb_agg(v),'[]'::jsonb) FROM (SELECT label,n::text AS count,round(n/NULLIF(total,0)*100,2)::text AS percentage FROM groups ORDER BY n ASC,label NULLS LAST LIMIT 3) v)) FROM stats))`;
  });
  const dates = plan.dates.map((name) => `jsonb_build_object('member',${literal(name)},'earliest',min(${alias(name)})::text,'latest',max(${alias(name)})::text)`);
  return { text: `WITH source AS (${compiled.text}) SELECT jsonb_build_object('population',COALESCE(sum(${weight}),0)::text,'scope',${literal(plan.grouped ? 'matching result groups; original grouping and aggregate thresholds preserved' : 'full matching records')},'numeric',jsonb_build_array(${entries.join(',')}),'categories',jsonb_build_array(${groups.join(',')}),'dates',jsonb_build_array(${dates.join(',')})) AS result FROM source`, values: compiled.values };
}

function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export async function collectReportSummary(catalog, query, compile, execute) {
  const plan = summaryPlan(catalog, query);
  const statement = summarySql(await compile(plan.query), plan);
  const summary = await execute(statement);
  const title = (member) => catalog.flatMap((c) => [...c.dimensions, ...c.measures]).find((f) => f.name === member || f.type === 'time' && member.startsWith(`${f.name}.`))?.title || member;
  return { ...summary, categories: (summary.categories || []).map((entry) => ({ ...entry, title: title(entry.member) })), dates: (summary.dates || []).map((entry) => ({ ...entry, title: title(entry.member) })), omittedFields: plan.omitted, rankingLimit: query.limit || null, approximation: false };
}
