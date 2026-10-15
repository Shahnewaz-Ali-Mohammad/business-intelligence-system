const scalar = { type: ['string', 'number', 'boolean'] };
const value = { anyOf: [scalar, { type: 'array', items: scalar, minItems: 1, maxItems: 100 }] };
function condition(depth = 2) {
  const leaf = { type: 'object', additionalProperties: false, properties: {
    field: { type: 'string', description: 'Exact approved field ID.' },
    operator: { type: 'string', enum: ['eq','ne','gt','gte','lt','lte','contains','in','between','is_null','not_null'] },
    value,
  }, required: ['field','operator'] };
  if (!depth) return leaf;
  const child = condition(depth - 1);
  return { anyOf: [leaf, ...['and','or'].map(key => ({ type: 'object', additionalProperties: false,
    properties: { [key]: { type: 'array', items: child, minItems: 1, maxItems: 50 } }, required: [key] })),
    { type: 'object', additionalProperties: false, properties: { not: child }, required: ['not'] }] };
}
export function queryInputSchema(definition) {
  const fields = definition.capabilities.fields;
  const field = { type: 'string', enum: fields };
  const array = (items, maxItems) => ({ type: 'array', items, maxItems });
  return { type: 'object', additionalProperties: false, description: 'Structured approved query. Put actual filter values in value, not parameter names. Text identifiers should be strings. Results appear in the application table, with pagination and export.', properties: {
    columns: array(field, 1000),
    allColumns: {type:'boolean',description:'True selects every approved column. Otherwise supply columns as an array of exact field IDs.'},
    where: condition(),
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Maximum result records/groups across all pages. Use 100 for first 100.' },
    sort: array({ type: 'object', additionalProperties: false, properties: { field: { type: 'string', description: 'Approved field ID or returned metric alias.' }, direction: {type:'string',enum:['asc','desc']} }, required: ['field','direction'] }, 5),
    distinct: { type: 'boolean' },
    joins: array({type:'string', ...(definition.capabilities.joins.length?{enum:definition.capabilities.joins}:{})},8),
    groupBy: array(field,5),
    metrics: array({type:'object',additionalProperties:false,properties:{field:{anyOf:[field,{type:'null'}]},operation:{type:'string',enum:['count','count_distinct','sum','avg','min','max']},alias:{type:'string',pattern:'^[a-z][a-z0-9_]{0,62}$'},where:{...condition(1),description:'Optional condition for this metric only (conditional count/sum), e.g. active customers next to all customers.'}},required:['field','operation','alias']},12),
    having: array({type:'object',additionalProperties:false,description:'Keep only groups whose metric meets the condition (e.g. customers with more than 5 tickets).',properties:{field:{type:'string',description:'Metric alias.'},operator:{type:'string',enum:['eq','ne','gt','gte','lt','lte']},value:{type:'number'}},required:['field','operator','value']},5),
    derived: array({type:'object',additionalProperties:false,description:'Calculated outputs. Aggregate queries use metric aliases as inputs; record queries use numeric field IDs. add/subtract/multiply/divide/percent_of take two inputs; percent_of_total (share %), running_total, change and percent_change vs previous period, moving_average (window) and rank take one. Period comparisons and growth: group by a dateGroups bucket and use change/percent_change.',properties:{alias:{type:'string',pattern:'^[a-z][a-z0-9_]{0,62}$'},operation:{type:'string',enum:['add','subtract','multiply','divide','percent_of','percent_of_total','running_total','change','percent_change','moving_average','rank']},inputs:{type:'array',items:{type:'string'},minItems:1,maxItems:2},window:{type:'integer',minimum:2,maximum:366}},required:['alias','operation','inputs']},8),
    dateGroups: array({type:'object',additionalProperties:false,properties:{field,grain:{type:'string',enum:['day','week','month','year']}},required:['field','grain']},5),
  } };
}
export function normalizeMcpArguments(definition, args) {
  if (definition.capabilities) {
    // Tolerate query options placed beside query instead of inside it.
    const keys=Object.keys(queryInputSchema(definition).properties);
    const outer=Object.entries(args).filter(([k])=>k!=='query'&&keys.includes(k));
    if(outer.length){
      const inner=typeof args.query==='string'?JSON.parse(args.query):{...(args.query||{})};
      for(const [k,v] of outer)if(inner[k]===undefined&&!(k==='allColumns'&&(v!==true||inner.columns!==undefined)))inner[k]=v;
      args={query:inner};
    }
  }
  if (definition.capabilities && definition.mode==='aggregate' && args.query && typeof args.query==='object' && Array.isArray(args.query.columns)) {
    // Columns on a summary tool mean "group by these" (date buckets are grouped already).
    const {columns,...rest}=args.query;const grouped=new Set([...(rest.groupBy||[]),...(rest.dateGroups||[]).map(g=>g.field)]);
    const metricFields=new Set((rest.metrics||[]).map(m=>m.field));
    const extra=columns.filter(f=>!grouped.has(f)&&!metricFields.has(f));
    args={...args,query:{...rest,...(extra.length||rest.groupBy?{groupBy:[...(rest.groupBy||[]),...extra].slice(0,5)}:{})}};
  }
  if (!definition.capabilities || args.query === undefined || typeof args.query === 'string') return args;
  if (!args.query || typeof args.query !== 'object' || Array.isArray(args.query)) throw new Error('Query must be an object.');
  const {allColumns,...query}=args.query;
  if(allColumns===true&&query.columns!==undefined)throw new Error('Use allColumns or columns, not both.');
  if(allColumns!==undefined&&typeof allColumns!=='boolean')throw new Error('allColumns must be boolean.');
  return { ...args, query: JSON.stringify({...query,...(allColumns&&definition.mode==='rows'?{columns:'*'}:{})}) };
}
