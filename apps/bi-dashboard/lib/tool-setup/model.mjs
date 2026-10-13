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
    joins: z.array(z.string()).max(8),
    mode: z.enum(["rows", "aggregate"]),
    columns: z.array(Field).max(30),
    groupBy: z.array(Field).max(5),
    metrics: z
      .array(
        z
          .object({
            field: Field.nullable(),
            operation: z.enum(["count", "sum", "avg", "min", "max"]),
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
export const BusinessDraftSchema = z.object({ tools: z.array(ToolSchema.omit({ capabilities: true })).min(1) }).strict();
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
  const selected = new Set([base.id]);
  const joins = [];
  for (const id of tool.joins) {
    const join = catalog.relationships.find((j) => j.id === id);
    if (
      !join ||
      !selected.has(join.from) ||
      selected.has(join.to) ||
      !catalog.objects.some((o) => o.id === join.to)
    )
      throw new Error(
        "Join must follow an available foreign key from the selected objects.",
      );
    if (!join.targetUnique)
      throw new Error("Join target uniqueness could not be verified.");
    selected.add(join.to);
    joins.push(join);
  }
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
      m.operation !== "count" &&
      !numericType(requireField(m.field).dataType)
    )
      throw new Error("Choose a numeric field for this metric.");
    if (m.field) requireField(m.field);
  });
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
    const plan = z.object({ values: z.record(z.string(), z.union([z.string().max(20000), z.number().finite(), z.boolean()])).default({}) }).strict().parse(JSON.parse(parameters.query));
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
        columns: ToolSchema.shape.columns.optional(),
        groupBy: ToolSchema.shape.groupBy.optional(),
        metrics: ToolSchema.shape.metrics.optional(),
        joins: ToolSchema.shape.joins.optional(),
        filters: ToolSchema.shape.filters.optional(),
        values: z
          .record(
            z.string(),
            z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
          )
          .optional(),
      })
      .strict()
      .parse(JSON.parse(parameters.query));
    const candidate = {
      ...input,
      columns: plan.columns ?? input.columns,
      groupBy: plan.groupBy ?? input.groupBy,
      metrics: plan.metrics ?? input.metrics,
      joins: plan.joins ?? [],
      filters: plan.filters ?? [],
    };
    delete candidate.capabilities;
    const used = [
      ...candidate.columns,
      ...candidate.groupBy,
      ...candidate.metrics.map((m) => m.field).filter(Boolean),
      ...candidate.filters.map((f) => f.field),
    ];
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
      options,
    );
  }
  const { tool, base, joins, fields } = validateTool(input, catalog);
  if (
    Object.keys(parameters).some(
      (p) => !tool.filters.some((f) => f.parameter === p),
    )
  )
    throw new Error("Unknown parameter.");
  const q = (id) => quote(id, dialect);
  const ids = [base.id, ...joins.map((j) => j.to)];
  const aliases = new Map(ids.map((id, index) => [id, `t${index}`]));
  const ref = (id) => {
    const f = fields.get(id);
    return `${q(aliases.get(f.object.id))}.${q(f.name)}`;
  };
  const table = (o) =>
    dialect === "mysql" ? q(o.name) : `${q(o.schema)}.${q(o.name)}`;
  const values = [];
  const bind = (value) => {
    values.push(value);
    return dialect === "postgres"
      ? `$${values.length}`
      : dialect === "sqlserver"
        ? `@p${values.length}`
        : "?";
  };
  const where = [];
  for (const f of tool.filters) {
    if (f.operator === "is_null" || f.operator === "not_null") {
      where.push(
        `${ref(f.field)} IS ${f.operator === "not_null" ? "NOT " : ""}NULL`,
      );
      continue;
    }
    const value = parameters[f.parameter];
    if (value === undefined || value === "") {
      if (f.required) throw new Error(`Enter ${f.parameter}.`);
      continue;
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
      where.push(`${ref(f.field)} LIKE ${bind(`%${escaped}%`)} ESCAPE '!'`);
    } else
      where.push(
        `${ref(f.field)} ${{ eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.operator]} ${bind(value)}`,
      );
  }
  const outputFields =
    tool.mode === "rows"
      ? tool.columns
      : [...tool.groupBy, ...tool.metrics.map((m) => m.alias)];
  const metric = (m) => {
    let expression = m.field ? ref(m.field) : "*";
    if (
      dialect === "sqlserver" &&
      ["avg", "sum"].includes(m.operation) &&
      m.field &&
      /^(?:tinyint|smallint|int|bigint)$/i.test(fields.get(m.field).dataType)
    )
      expression = `CAST(${expression} AS DECIMAL(38,${m.operation === "avg" ? 6 : 0}))`;
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
  // Chat previews and pages default to 100 rows per query; the full
  // export raises the page size (options.maxLimit) to read in larger batches.
  const bound = Math.min(
    Math.min(Number.isInteger(options.maxLimit) ? options.maxLimit : 100, 5000),
    Math.max(1, Number.isInteger(limit) ? limit : 50),
  );
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000)
    throw new Error("Invalid page offset.");
  let sql = `SELECT ${dialect === "sqlserver" && !offset ? `TOP (${bound + 1}) ` : ""}${selections.join(", ")} FROM ${table(base)} AS ${q("t0")}`;
  for (const join of joins) {
    const target = catalog.objects.find((o) => o.id === join.to);
    sql += ` LEFT JOIN ${table(target)} AS ${q(aliases.get(join.to))} ON ${join.columns.map((c) => `${q(aliases.get(join.from))}.${q(c.from)} = ${q(aliases.get(join.to))}.${q(c.to)}`).join(" AND ")}`;
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  if (tool.mode === "aggregate" && tool.groupBy.length)
    sql += ` GROUP BY ${tool.groupBy.map(ref).join(", ")}`;
  const populationSql = sql.replace(/^SELECT TOP \(\d+\) /, "SELECT ");
  if (tool.mode === "aggregate")
    sql += ` ORDER BY ${q(`c${tool.groupBy.length}`)} DESC${tool.groupBy.map((_, i) => `, ${q(`c${i}`)} ASC`).join("")}`;
  else {
    const keys = base.columns.filter((c) => c.isPrimaryKey);
    if (offset && !keys.length)
      throw new Error("Pagination needs a stable primary key.");
    if (keys.length)
      sql += ` ORDER BY ${keys.map((c) => `${q("t0")}.${q(c.name)}`).join(", ")}`;
  }
  if (dialect !== "sqlserver")
    sql += ` LIMIT ${bound + 1}${offset ? ` OFFSET ${offset}` : ""}`;
  else if (offset) {
    if (!sql.includes(" ORDER BY "))
      throw new Error("Pagination needs a stable ordering key.");
    sql += ` OFFSET ${offset} ROWS FETCH NEXT ${bound + 1} ROWS ONLY`;
  }
  return { sql, populationSql, values, limit: bound, outputFields };
}
