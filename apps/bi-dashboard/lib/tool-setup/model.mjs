import {queryValue,whereSchema,whereFields,orientJoins,inferJoins,measureIsSafe,dateExpression} from './query-scenarios.mjs';
import { z } from "zod";
import crypto from "node:crypto";

export const ConnectionSchema = z
  .object({
    dialect: z.enum(["postgres", "mysql", "sqlserver"]),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(200),
    password: z.string().max(1000),
    database: z.string().min(1).max(128),
    tls: z.boolean().default(true),
    trustServerCertificate: z.boolean().default(false),
  })
  .strict();
const Field = z.string().min(1).max(400);
export const ToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    description: z.string().min(10).max(1500),
    base: z.string().min(1).max(300),
    capabilities: z
      .object({ fields: z.array(Field).min(1), joins: z.array(z.string()) })
      .strict()
      .optional(),
    template: z.object({projection:z.boolean(),limit:z.boolean(),sortFields:z.array(z.string()),sort:z.array(z.object({field:Field,direction:z.enum(['asc','desc'])}).strict()).max(5),dateGroups:z.array(z.object({field:Field,grain:z.enum(['day','week','month','year'])}).strict()).max(5)}).strict().optional(),
    joins: z.array(z.string()).max(8),
    mode: z.enum(["rows", "aggregate"]),
    columns: z.array(Field).max(1000),
    groupBy: z.array(Field).max(5),
    metrics: z
      .array(
        z
          .object({
            field: Field.nullable(),
            operation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
            alias: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
          })
          .strict(),
      )
      .max(8),
    filters: z
      .array(
        z
          .object({
            field: Field,
            operator: z.enum([
              "eq",
              "ne",
              "gt",
              "gte",
              "lt",
              "lte",
              "contains",
              "in",
              "between",
              "is_null",
              "not_null",
            ]),
            parameter: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
// AI business definitions have fixed report fields. Generic capabilities are generated separately.
export const BusinessDraftSchema = z.object({ tools: z.array(ToolSchema.omit({ capabilities: true, template: true })).min(1) }).strict();
export const DraftSchema = z
  .object({ tools: z.array(ToolSchema).min(1) })
  .strict();
export const fingerprint = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function quote(name, dialect) {
  if (typeof name !== "string" || !name || name.includes("\0"))
    throw new Error("Invalid identifier.");
  return dialect === "mysql"
    ? `\`${name.replaceAll("`", "``")}\``
    : dialect === "sqlserver"
      ? `[${name.replaceAll("]", "]]")}]`
      : `"${name.replaceAll('"', '""')}"`;
}
export const fieldId = (object, column) => `${object.id}:${column.name}`;
export const isProtectedColumn = (name) =>
  /password|passwd|secret|token|api.?key|private.?key/i.test(name);
export const numericType = (type) =>
  /^(?:tinyint|smallint|int|integer|bigint|decimal|numeric|real|float|double|money|smallmoney)(?:\b|$)/i.test(
    type,
  );
export function validateTool(input, catalog) {
  const tool = ToolSchema.parse(input);
  const base = catalog.objects.find(
    (o) => o.id === tool.base && o.kind !== "procedure",
  );
  if (!base) throw new Error("Choose an available table or view.");
  if (tool.capabilities) {
    for (const id of tool.capabilities.fields) {
      const column = catalog.objects
        .flatMap((o) =>
          o.columns.map((c) => ({ id: fieldId(o, c), column: c })),
        )
        .find((c) => c.id === id)?.column;
      if (!column || isProtectedColumn(column.name))
        throw new Error("Invalid capability field.");
    }
    for (const id of tool.capabilities.joins) {
      const join = catalog.relationships.find((j) => j.id === id);
      if (!join?.targetUnique)
        throw new Error("Invalid capability relationship.");
      if (
        !join.columns.every(
          (c) =>
            tool.capabilities.fields.includes(`${join.from}:${c.from}`) &&
            tool.capabilities.fields.includes(`${join.to}:${c.to}`),
        )
      )
        throw new Error("Join keys must be approved capability fields.");
    }
  }
  const {selected,joins}=orientJoins(base.id,tool.joins,catalog);
  const fields = new Map(
    catalog.objects
      .filter((o) => selected.has(o.id))
      .flatMap((o) =>
        o.columns.map((c) => [fieldId(o, c), { ...c, object: o }]),
      ),
  );
  const requireField = (id) => {
    if (!fields.has(id))
      throw new Error(`Field is not available to this tool: ${id}`);
    if (isProtectedColumn(fields.get(id).name))
      throw new Error(
        "Credential and secret columns cannot be exposed as BI tools.",
      );
    return fields.get(id);
  };
  [
    ...tool.columns,
    ...tool.groupBy,
    ...tool.filters.map((f) => f.field),
  ].forEach(requireField);
  joins.forEach((j) =>
    j.columns.forEach((c) => {
      requireField(`${j.from}:${c.from}`);
      requireField(`${j.to}:${c.to}`);
    }),
  );
  tool.filters.forEach((f) => {
    if (
      f.operator === "contains" &&
      !/(?:char|text|clob|enum|set)/i.test(requireField(f.field).dataType)
    )
      throw new Error("Contains filters require a text column.");
  });
  tool.metrics.forEach((m) => {
    if (!m.field && m.operation !== "count")
      throw new Error("Only count can omit a field.");
    if (
      m.field &&
      !["count","count_distinct"].includes(m.operation) &&
      !numericType(requireField(m.field).dataType) &&
      // Earliest/latest dates and first/last text values are valid min/max.
      !(["min","max"].includes(m.operation) && /date|time|char|text/i.test(requireField(m.field).dataType))
    )
      throw new Error("Choose a numeric field for this metric.");
    if (m.field) requireField(m.field);
  });
  if(joins.some(j=>j.fanout))for(const metric of tool.metrics){
    if(metric.operation==='count_distinct'||['min','max'].includes(metric.operation))continue;
    if(!metric.field||!measureIsSafe(requireField(metric.field).object.id,base.id,joins))throw new Error('This join would multiply the requested measure. Use a distinct count, aggregate the child table first, or separate tools for independent totals.');
  }
  if (
    tool.mode === "rows" &&
    (!tool.columns.length || tool.groupBy.length || tool.metrics.length)
  )
    throw new Error("Row tools need columns, without grouping or metrics.");
  if (
    tool.mode === "aggregate" &&
    (!tool.metrics.length || tool.columns.length)
  )
    throw new Error(
      "Aggregate tools need metrics and optional grouping, without row columns.",
    );
  if (new Set(tool.metrics.map((m) => m.alias)).size !== tool.metrics.length)
    throw new Error("Metric names must be unique.");
  const outputNames = [
    ...(tool.mode === "rows" ? tool.columns : tool.groupBy),
    ...tool.metrics.map((m) => m.alias),
  ];
  if (new Set(outputNames).size !== outputNames.length)
    throw new Error("Output fields must be unique.");
  if (
    new Set(tool.filters.map((f) => f.parameter)).size !== tool.filters.length
  )
    throw new Error("Filter parameter names must be unique.");
  return { tool, base, joins, fields };
}

// AI proposes a structured plan, never executable SQL. Only this compiler creates SELECTs.
export function compileTool(
  input,
  catalog,
  dialect,
  parameters = {},
  limit = 50,
  offset = 0,
  options = {},
) {
  if (!input.capabilities && parameters.query !== undefined) {
    if (Object.keys(parameters).some((k) => k !== 'query') || typeof parameters.query !== 'string' || parameters.query.length > 20000)
      throw new Error('Invalid fixed-tool plan.');
    const plan = z.object({ values: z.record(z.string(), z.union([queryValue,z.array(z.string().max(400)).min(1).max(1000)])).default({}) }).strict().parse(JSON.parse(parameters.query));
    return compileTool(input, catalog, dialect, plan.values, limit, offset, options);
  }
  if (input.capabilities && parameters.query !== undefined) {
    validateTool(input, catalog);
    if (Object.keys(parameters).some((k) => k !== "query"))
      throw new Error("Unknown parameter.");
    if (typeof parameters.query !== "string" || parameters.query.length > 20000)
      throw new Error("Invalid query plan.");
    const plan = z
      .object({
        columns: z.union([ToolSchema.shape.columns,z.literal("*")]).optional(),
        groupBy: ToolSchema.shape.groupBy.optional(),
        metrics: z.array(z.object({field:Field.nullable(),operation:z.enum(["count","count_distinct","sum","avg","min","max"]),alias:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),where:whereSchema.optional()}).strict()).max(12).optional(),
        having: z.array(z.object({field:z.string(),operator:z.enum(['eq','ne','gt','gte','lt','lte']),value:z.number().finite()}).strict()).max(5).optional(),
        derived: z.array(z.object({alias:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),operation:z.enum(['add','subtract','multiply','divide','percent_of','percent_of_total','running_total','change','percent_change','moving_average','rank']),inputs:z.array(z.string()).min(1).max(2),window:z.number().int().min(2).max(366).optional()}).strict()).max(8).optional(),
        joins: ToolSchema.shape.joins.optional(),
        filters: ToolSchema.shape.filters.optional(),
        where: whereSchema.optional(),
        sort: z.array(z.object({field:Field,direction:z.enum(['asc','desc'])}).strict()).max(5).optional(),
        distinct: z.boolean().optional(),
        limit: z.number().int().min(1).max(100000).optional(),
        dateGroups: z.array(z.object({field:Field,grain:z.enum(['day','week','month','year'])}).strict()).max(5).optional(),
        values: z
          .record(
            z.string(),
            queryValue,
          )
          .optional(),
      })
      .strict()
      .parse(JSON.parse(parameters.query));
    const candidate = {
      ...input,
      // "All columns" means the base table's own fields; joined fields are added only when named.
      columns: plan.columns === "*" ? input.capabilities.fields.filter((f) => f.startsWith(input.base + ":")) : plan.columns ?? input.columns,
      // A date bucket is always a grouping: add its field when the plan
      // forgot to list it in groupBy.
      groupBy: [...new Set([...(plan.groupBy ?? input.groupBy), ...(plan.dateGroups || []).map((g) => g.field)])],
      metrics: plan.metrics ? plan.metrics.map(({where,...m})=>m) : input.metrics,
      joins: plan.joins ?? [],
      filters: plan.filters ?? [],
    };
    delete candidate.capabilities;
    const used = [
      ...candidate.columns,
      ...candidate.groupBy,
      ...candidate.metrics.map((m) => m.field).filter(Boolean),
      ...candidate.filters.map((f) => f.field),
      ...whereFields(plan.where),
      ...(plan.metrics||[]).flatMap(m=>m.where?whereFields(m.where):[]),
      ...(plan.derived||[]).flatMap(d=>d.inputs).filter(i=>i.includes(':')),
      ...(plan.dateGroups||[]).map(g=>g.field),
      ...(plan.sort||[]).filter(sort=>!candidate.metrics.some(m=>m.alias===sort.field)&&!(plan.derived||[]).some(d=>d.alias===sort.field)).map(sort=>sort.field),
    ];
    if(plan.joins===undefined)candidate.joins=inferJoins(candidate.base,used,catalog,input.capabilities.joins);
    if (
      used.some((f) => !input.capabilities.fields.includes(f)) ||
      candidate.joins.some((j) => !input.capabilities.joins.includes(j))
    )
      throw new Error("Query exceeds approved capabilities.");
    return compileTool(
      candidate,
      catalog,
      dialect,
      plan.values ?? {},
      limit,
      offset,
      {...options,queryPlan:plan},
    );
  }
  let templateRuntime;
  if(input.template){
    const {report_columns,report_limit,report_sort_field,report_sort_direction,...bindings}=parameters;
    const approved=input.template;
    if(report_columns!==undefined&&(!approved.projection||input.mode!=='rows'||!Array.isArray(report_columns)||!report_columns.length||report_columns.some(f=>!input.columns.includes(f))))throw new Error('Choose output fields from this saved report.');
    if(report_limit!==undefined&&(!approved.limit||!Number.isSafeInteger(report_limit)||report_limit<1||report_limit>100000))throw new Error('Invalid saved report row limit.');
    if(report_sort_field!==undefined&&!approved.sortFields.includes(report_sort_field))throw new Error('Ordering field is not approved for this saved report.');
    if(report_sort_direction!==undefined&&!['asc','desc'].includes(report_sort_direction))throw new Error('Invalid saved report ordering direction.');
    if(report_sort_direction!==undefined&&report_sort_field===undefined)throw new Error('Choose an ordering field.');
    templateRuntime={sort:report_sort_field?[{field:report_sort_field,direction:report_sort_direction||'asc'}]:approved.sort,dateGroups:approved.dateGroups,...(report_limit!==undefined?{limit:report_limit}:{})};
    input={...input,...(report_columns?{columns:report_columns}:{})};parameters=bindings;
  }
  const { tool, base, joins, fields } = validateTool(input, catalog);
  if (
    Object.keys(parameters).some(
      (p) => !tool.filters.some((f) => f.parameter === p) && !JSON.stringify(options.queryPlan?.where||{}).includes(`"parameter":"${p}"`),
    )
  )
    throw new Error("Unknown parameter.");
  const q = (id) => quote(id, dialect);
  const ids = [base.id, ...joins.map((j) => j.to)];
  const aliases = new Map(ids.map((id, index) => [id, `t${index}`]));
  const rawRef = (id) => {
    const f=fields.get(id);if(!f||isProtectedColumn(f.name))throw new Error(`Unavailable query field: ${id}`);
    return `${q(aliases.get(f.object.id))}.${q(f.name)}`;
  };
  const runtime=templateRuntime||options.queryPlan||{};
  for(const group of runtime.dateGroups||[]){if(!tool.groupBy.includes(group.field)||!/(date|time)/i.test(fields.get(group.field)?.dataType||''))throw new Error('Date grouping needs a grouped date/time field.');}
  const derivedAliases=new Set((runtime.derived||[]).map(d=>d.alias));
  for(const sort of runtime.sort||[]){if(!tool.metrics.some(m=>m.alias===sort.field)&&!derivedAliases.has(sort.field))rawRef(sort.field);}
  const ref=id=>{const group=runtime.dateGroups?.find(g=>g.field===id);return group?dateExpression(rawRef(id),group.grain,dialect):rawRef(id);};
  const table = (o) =>
    dialect === "mysql" ? q(o.name) : `${q(o.schema)}.${q(o.name)}`;
  let values = [];
  const bind = (value, field) => {
    // Text identifiers may contain both numeric-looking and prefixed values.
    // Binding a number against varchar forces SQL Server to convert every row.
    const type = fields.get(field)?.dataType || "";
    values.push(/(?:char|text|clob|enum|set|uuid|uniqueidentifier)/i.test(type) ? String(value) : value);
    return dialect === "postgres"
      ? `$${values.length}`
      : dialect === "sqlserver"
        ? `@p${values.length}`
        : `?{${values.length}}`;
  };
  const where = [];
  for (const f of tool.filters) {
    if (f.operator === "is_null" || f.operator === "not_null") {
      where.push(
        `${rawRef(f.field)} IS ${f.operator === "not_null" ? "NOT " : ""}NULL`,
      );
      continue;
    }
    const value = parameters[f.parameter];
    if (value === undefined || value === "") {
      if (f.required) throw new Error(`Enter ${f.parameter}.`);
      continue;
    }
    if(f.operator==='in'||f.operator==='between'){
      if(!Array.isArray(value)||!value.length||value.length>100||f.operator==='between'&&value.length!==2||value.some(v=>v===null||!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw new Error('List filters need 1-100 scalar values; between needs two.');
      where.push(f.operator==='in'?`${rawRef(f.field)} IN (${value.map(v=>bind(v,f.field)).join(', ')})`:`${rawRef(f.field)} BETWEEN ${bind(value[0],f.field)} AND ${bind(value[1],f.field)}`);continue;
    }
    if (
      value === null ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "string" && value.length > 1000) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Invalid filter value.");
    if (f.operator === "contains") {
      const escaped = String(value)
        .replaceAll("!", "!!")
        .replaceAll("%", "!%")
        .replaceAll("_", "!_")
        .replaceAll("[", "![");
      where.push(`${rawRef(f.field)} LIKE ${bind(`%${escaped}%`,f.field)} ESCAPE '!'`);
    } else
      where.push(
        `${rawRef(f.field)} ${{ eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.operator]} ${bind(value,f.field)}`,
      );
  }
  const compileWhere=node=>{
    if(node.and||node.or)return '('+(node.and||node.or).map(compileWhere).join(node.and?' AND ':' OR ')+')';
    if(node.not)return `(NOT ${compileWhere(node.not)})`;
    const column=rawRef(node.field);if(['is_null','not_null'].includes(node.operator))return `${column} IS ${node.operator==='not_null'?'NOT ':''}NULL`;
    if(node.parameter&&node.value!==undefined)throw new Error('Use either a filter value or parameter, not both.');
    const value=node.parameter?parameters[node.parameter]:node.value;
    if(value===undefined)throw new Error('A filter value or parameter binding is required.');
    if(['in','between'].includes(node.operator)){if(!Array.isArray(value)||!value.length||value.length>100||node.operator==='between'&&value.length!==2)throw new Error('Invalid list or range filter.');return node.operator==='in'?`${column} IN (${value.map(v=>bind(v,node.field)).join(', ')})`:`${column} BETWEEN ${bind(value[0],node.field)} AND ${bind(value[1],node.field)}`;}
    if(Array.isArray(value))throw new Error('This operator requires one value.');
    if(node.operator==='contains'){if(!/(char|text|clob|enum|set)/i.test(fields.get(node.field).dataType))throw new Error('Contains filters require a text column.');return `${column} LIKE ${bind('%'+String(value).replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_').replaceAll('[','![')+'%',node.field)} ESCAPE '!'`;}
    return `${column} ${{eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}[node.operator]} ${bind(value,node.field)}`;
  };
  if(runtime.where){whereFields(runtime.where);where.push(compileWhere(runtime.where));}
  if(runtime.distinct&&tool.mode!=='rows')throw new Error('Distinct rows apply to a record query; use count_distinct for an aggregate.');
  const outputFields =
    tool.mode === "rows"
      ? [...tool.columns]
      : [...tool.groupBy, ...tool.metrics.map((m) => m.alias)];
  const metricWhere=new Map((runtime.metrics||[]).filter(m=>m.where).map(m=>[m.alias,m.where]));
  const metric = (m) => {
    let expression = m.field ? rawRef(m.field) : "*";
    const condition=metricWhere.get(m.alias);
    if(condition)expression=`CASE WHEN ${compileWhere(condition)} THEN ${m.field?expression:'1'} END`;
    if (
      dialect === "sqlserver" &&
      ["avg", "sum"].includes(m.operation) &&
      m.field &&
      /^(?:tinyint|smallint|int|bigint)$/i.test(fields.get(m.field).dataType)
    )
      expression = `CAST(${expression} AS DECIMAL(38,${m.operation === "avg" ? 6 : 0}))`;
    if(m.operation==='count_distinct')return `${dialect==='sqlserver'?'COUNT_BIG':'COUNT'}(DISTINCT ${expression})`;
    return `${dialect === "sqlserver" && m.operation === "count" ? "COUNT_BIG" : m.operation.toUpperCase()}(${expression})`;
  };
  const selections =
    tool.mode === "rows"
      ? tool.columns.map((id, index) => `${ref(id)} AS ${q(`c${index}`)}`)
      : [
          ...tool.groupBy.map((id, index) => `${ref(id)} AS ${q(`c${index}`)}`),
          ...tool.metrics.map(
            (m, index) =>
              `${metric(m)} AS ${q(`c${tool.groupBy.length + index}`)}`,
          ),
        ];
  const numeric=id=>/(int|dec|num|money|float|real|double)/i.test(fields.get(id)?.dataType||'');
  const operand=name=>{
    const m=tool.metrics.find(x=>x.alias===name);
    if(tool.mode==='aggregate'){if(!m)throw new Error(`Calculations use returned metric aliases: ${name}`);return `CAST(${metric(m)} AS DECIMAL(38,6))`;}
    if(!tool.columns.includes(name)||!numeric(name))throw new Error(`Calculations need returned numeric columns: ${name}`);
    return `CAST(${rawRef(name)} AS DECIMAL(38,6))`;
  };
  const orderKey=()=>{const key=runtime.dateGroups?.[0]?.field||tool.groupBy[0];if(tool.mode!=='aggregate'||!key)throw new Error('Running totals, changes and moving averages need a grouping (for example a date bucket).');return ref(key);};
  for(const d of runtime.derived||[]){
    const [a,b]=d.inputs.map(operand);
    const two=['add','subtract','multiply','divide','percent_of'].includes(d.operation);
    if(two!==(d.inputs.length===2))throw new Error(`${d.operation} takes ${two?'two inputs':'one input'}.`);
    if(['percent_of_total'].includes(d.operation)&&tool.mode!=='aggregate')throw new Error('Share of total needs an aggregate query.');
    const expr={add:`(${a} + ${b})`,subtract:`(${a} - ${b})`,multiply:`(${a} * ${b})`,divide:`(${a} / NULLIF(${b}, 0))`,percent_of:`(100.0 * ${a} / NULLIF(${b}, 0))`,
      percent_of_total:`(100.0 * ${a} / NULLIF(SUM(${a}) OVER (), 0))`,rank:`RANK() OVER (ORDER BY ${a} DESC)`}[d.operation]
      ?? {running_total:()=>`SUM(${a}) OVER (ORDER BY ${orderKey()} ROWS UNBOUNDED PRECEDING)`,change:()=>`(${a} - LAG(${a}) OVER (ORDER BY ${orderKey()}))`,
        percent_change:()=>`(100.0 * (${a} - LAG(${a}) OVER (ORDER BY ${orderKey()})) / NULLIF(LAG(${a}) OVER (ORDER BY ${orderKey()}), 0))`,
        moving_average:()=>`AVG(${a}) OVER (ORDER BY ${orderKey()} ROWS BETWEEN ${(d.window||3)-1} PRECEDING AND CURRENT ROW)`}[d.operation]();
    selections.push(`${expr} AS ${q(`c${outputFields.length}`)}`);outputFields.push(d.alias);
  }
  if(new Set(outputFields).size!==outputFields.length)throw new Error('Returned names must be unique.');
  // Chat previews and pages default to 100 rows per query; the full
  // export raises the page size (options.maxLimit) to read in larger batches.
  const requestedBound = Math.min(
    Math.min(Number.isInteger(options.maxLimit) ? options.maxLimit : 100, 5000),
    Math.max(1, Number.isInteger(limit) ? limit : 50),
  );
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000)
    throw new Error("Invalid page offset.");
  const bound = runtime.limit === undefined ? requestedBound : Math.min(requestedBound,Math.max(0,runtime.limit-offset));
  const fetchCount = runtime.limit === undefined ? bound+1 : Math.min(bound+1,Math.max(0,runtime.limit-offset));
  let sql = `SELECT ${runtime.distinct?'DISTINCT ':''}${dialect === "sqlserver" && !offset ? `TOP (${fetchCount}) ` : ""}${selections.join(", ")} FROM ${table(base)} AS ${q("t0")}`;
  for (const join of joins) {
    const target = catalog.objects.find((o) => o.id === join.to);
    sql += ` LEFT JOIN ${table(target)} AS ${q(aliases.get(join.to))} ON ${join.columns.map((c) => `${q(aliases.get(join.from))}.${q(c.from)} = ${q(aliases.get(join.to))}.${q(c.to)}`).join(" AND ")}`;
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  if (tool.mode === "aggregate" && tool.groupBy.length)
    sql += ` GROUP BY ${tool.groupBy.map(ref).join(", ")}`;
  if(runtime.having?.length){
    if(tool.mode!=='aggregate')throw new Error('Metric conditions need an aggregate query.');
    sql+=` HAVING ${runtime.having.map(h=>{const m=tool.metrics.find(x=>x.alias===h.field);if(!m)throw new Error('Metric conditions use returned metric aliases.');values.push(h.value);const p=dialect==='postgres'?`$${values.length}`:dialect==='sqlserver'?`@p${values.length}`:`?{${values.length}}`;return `${metric(m)} ${{eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}[h.operator]} ${p}`;}).join(' AND ')}`;
  }
  let populationSql = sql.replace(/^SELECT (DISTINCT )?TOP \(\d+\) /, "SELECT $1");
  const ordering=[],orderedFields=new Set();
  for(const sort of runtime.sort||[]){
    const index=outputFields.indexOf(sort.field);
    if(tool.mode==='aggregate'&&index<0)throw new Error('Aggregate sort must use a returned grouping or metric.');
    if(runtime.distinct&&index<0)throw new Error('Distinct sorting requires a returned column.');
    ordering.push(`${index>=0?q(`c${index}`):rawRef(sort.field)} ${sort.direction.toUpperCase()}`);orderedFields.add(sort.field);
  }
  if(tool.mode==='aggregate'){
    if(!ordering.length)ordering.push(`${q(`c${tool.groupBy.length}`)} DESC`);
    tool.groupBy.forEach((field,index)=>{if(!orderedFields.has(field))ordering.push(`${q(`c${index}`)} ASC`);});
  }else if(runtime.distinct){tool.columns.forEach((field,index)=>{if(!orderedFields.has(field))ordering.push(`${q(`c${index}`)} ASC`);});}
  else for(const id of ids){
    const object=catalog.objects.find(o=>o.id===id),keys=object.columns.filter(c=>c.isPrimaryKey);
    const tieFields=keys.length?keys:object.columns.filter(c=>!isProtectedColumn(c.name)&&!/(?:^text$|^ntext$|image|xml|json|bytea|binary)/i.test(c.dataType));
    if(offset&&!tieFields.length)throw new Error('Pagination needs comparable ordering fields or a verified key.');
    tieFields.forEach(c=>{const field=`${id}:${c.name}`;if(!orderedFields.has(field)){ordering.push(`${q(aliases.get(id))}.${q(c.name)} ASC`);orderedFields.add(field);}});
  }
  const orderClause=ordering.length?` ORDER BY ${[...new Set(ordering)].join(', ')}`:'';
  if(runtime.limit!==undefined){
    populationSql = dialect==='sqlserver' ? populationSql.replace(/^SELECT (DISTINCT )?/,`SELECT $1TOP (${runtime.limit}) `)+orderClause : populationSql+orderClause+` LIMIT ${runtime.limit}`;
  }
  sql+=orderClause;
  if (dialect !== "sqlserver")
    sql += ` LIMIT ${fetchCount}${offset ? ` OFFSET ${offset}` : ""}`;
  else if (offset) {
    if (!sql.includes(" ORDER BY "))
      throw new Error("Pagination needs a stable ordering key.");
    sql += ` OFFSET ${offset} ROWS FETCH NEXT ${fetchCount} ROWS ONLY`;
  }
  if(fetchCount===0)sql=`SELECT * FROM (${populationSql}) AS ${q('empty_result')} WHERE 1=0`;
  // Positional placeholders: emit values in the order they appear in the SQL.
  let ordered=values;
  if(dialect!=='postgres'&&dialect!=='sqlserver'){
    const order=text=>{const out=[];return [text.replace(/\?\{(\d+)\}/g,(_,n)=>{out.push(values[n-1]);return '?';}),out];};
    [populationSql]=order(populationSql);[sql,ordered]=order(sql);
  }
  values=ordered;
  return { sql, populationSql, values, limit: bound, outputFields, joinIds:joins.map(j=>j.id),
    grain:joins.some(j=>j.fanout)?'Joined rows; not a count of distinct base records. Aggregates follow the explicitly requested measure.':null,
    unsafeAggregateFields:tool.mode==='rows'?tool.columns.filter(id=>!measureIsSafe(fields.get(id).object.id,base.id,joins)):[] };
}
