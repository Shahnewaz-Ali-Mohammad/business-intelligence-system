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
    metrics: array({type:'object',additionalProperties:false,properties:{field:{anyOf:[field,{type:'null'}]},operation:{type:'string',enum:['count','count_distinct','sum','avg','min','max']},alias:{type:'string',pattern:'^[a-z][a-z0-9_]{0,62}$'}},required:['field','operation','alias']},8),
    dateGroups: array({type:'object',additionalProperties:false,properties:{field,grain:{type:'string',enum:['day','week','month','year']}},required:['field','grain']},5),
  } };
}
export function normalizeMcpArguments(definition, args) {
  if (!definition.capabilities || args.query === undefined || typeof args.query === 'string') return args;
  if (!args.query || typeof args.query !== 'object' || Array.isArray(args.query)) throw new Error('Query must be an object.');
  const {allColumns,...query}=args.query;
  if(allColumns===true&&query.columns!==undefined)throw new Error('Use allColumns or columns, not both.');
  if(allColumns!==undefined&&typeof allColumns!=='boolean')throw new Error('allColumns must be boolean.');
  return { ...args, query: JSON.stringify({...query,...(allColumns?{columns:'*'}:{})}) };
}
