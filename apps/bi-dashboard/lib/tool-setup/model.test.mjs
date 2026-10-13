import test from "node:test";
import assert from "node:assert/strict";
import {
  compileTool,
  validateTool,
  ConnectionSchema,
  fingerprint,
  quote,
} from "./model.mjs";

// In-memory metadata fixtures only. These tests never connect to, create, or seed a database.
const catalog = {
  objects: [
    {
      id: "dbo.Tickets",
      schema: "dbo",
      name: "Tickets",
      kind: "table",
      columns: [
        { name: "Id", dataType: "int", isPrimaryKey: true },
        { name: "LinkId", dataType: "int" },
        { name: "CustomerId", dataType: "int" },
        { name: "Amount", dataType: "decimal" },
        { name: "Subject", dataType: "varchar" },
      ],
    },
    {
      id: "dbo.Customers",
      schema: "dbo",
      name: "Customers",
      kind: "table",
      columns: [
        { name: "Id", dataType: "int", isPrimaryKey: true },
        { name: "Name", dataType: "nvarchar" },
      ],
    },
    {
      id: "dbo.Reports",
      schema: "dbo",
      name: "Reports",
      kind: "view",
      columns: [{ name: "Total", dataType: "numeric" }],
    },
    { id: "dbo.SendEmail", kind: "procedure", columns: [] },
  ],
  relationships: [
    {
      id: "fk_customer",
      from: "dbo.Tickets",
      to: "dbo.Customers",
      targetUnique: true,
      columns: [{ from: "CustomerId", to: "Id" }],
    },
  ],
};
const rows = {
  name: "list_tickets",
  description: "List matching individual tickets.",
  base: "dbo.Tickets",
  joins: [],
  mode: "rows",
  columns: ["dbo.Tickets:Id", "dbo.Tickets:LinkId"],
  groupBy: [],
  metrics: [],
  filters: [],
};
const aggregate = {
  ...rows,
  name: "ticket_summary",
  mode: "aggregate",
  columns: [],
  metrics: [{ operation: "count", field: null, alias: "ticket_count" }],
};
for (const dialect of ["postgres", "mysql", "sqlserver"]) {
  test(`${dialect}: broad lists need no specific ID and stay bounded`, () => {
    const result = compileTool(rows, catalog, dialect, {}, 5000000000);
    assert.equal(result.limit, 100);
    assert.deepEqual(result.values, []);
    assert.match(result.sql, /^SELECT /);
    assert.match(
      result.sql,
      dialect === "sqlserver" ? /TOP \(101\)/ : /LIMIT 101$/,
    );
  });
  test(`${dialect}: non-null LinkId is a predicate, not an ID question`, () => {
    const result = compileTool(
      {
        ...rows,
        filters: [
          {
            field: "dbo.Tickets:LinkId",
            operator: "not_null",
            parameter: "link_id",
            required: true,
          },
        ],
      },
      catalog,
      dialect,
    );
    assert.match(result.sql, /IS NOT NULL/);
    assert.deepEqual(result.values, []);
  });
  test(`${dialect}: grouping and global aggregates run in database`, () => {
    const result = compileTool(
      { ...aggregate, groupBy: ["dbo.Tickets:LinkId"] },
      catalog,
      dialect,
    );
    assert.match(
      result.sql,
      dialect === "sqlserver" ? /COUNT_BIG\(\*\)/ : /COUNT\(\*\)/,
    );
    assert.match(result.sql, /GROUP BY/);
    assert.match(result.sql, /ORDER BY/);
  });
  test(`${dialect}: specific IDs use parameters`, () => {
    const tool = {
      ...rows,
      filters: [
        {
          field: "dbo.Tickets:Id",
          operator: "eq",
          parameter: "id",
          required: true,
        },
      ],
    };
    assert.throws(() => compileTool(tool, catalog, dialect), /Enter id/);
    const result = compileTool(tool, catalog, dialect, { id: 12 });
    assert.deepEqual(result.values, [12]);
    assert.doesNotMatch(result.sql, /= 12/);
  });
  test(`${dialect}: injected filter values never become SQL`, () => {
    const payload = "x'; DROP TABLE Tickets; --";
    const result = compileTool(
      {
        ...rows,
        filters: [
          {
            field: "dbo.Tickets:Subject",
            operator: "eq",
            parameter: "subject",
            required: false,
          },
        ],
      },
      catalog,
      dialect,
      { subject: payload },
    );
    assert.deepEqual(result.values, [payload]);
    assert.ok(!result.sql.includes(payload));
  });
  test(`${dialect}: verified join preserves tickets with missing customers`, () => {
    const result = compileTool(
      {
        ...rows,
        joins: ["fk_customer"],
        columns: ["dbo.Tickets:Id", "dbo.Customers:Name"],
      },
      catalog,
      dialect,
    );
    assert.match(result.sql, /LEFT JOIN/);
    assert.match(result.sql, / ON /);
  });
}
test("every supported filter compiles", () => {
  for (const operator of [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "is_null",
    "not_null",
  ]) {
    const result = compileTool(
      {
        ...rows,
        filters: [
          {
            field: "dbo.Tickets:Subject",
            operator,
            parameter: "value",
            required: false,
          },
        ],
      },
      catalog,
      "postgres",
      { value: "hello" },
    );
    assert.match(result.sql, /WHERE/);
  }
});
test("LIKE wildcard characters are escaped", () => {
  const result = compileTool(
    {
      ...rows,
      filters: [
        {
          field: "dbo.Tickets:Subject",
          operator: "contains",
          parameter: "subject",
          required: false,
        },
      ],
    },
    catalog,
    "mysql",
    { subject: "a%_!" },
  );
  assert.deepEqual(result.values, ["%a!%!_!!%"]);
  assert.match(result.sql, /ESCAPE '!'/);
});
test("all numeric aggregate operators compile", () => {
  for (const operation of ["sum", "avg", "min", "max"])
    assert.match(
      compileTool(
        {
          ...aggregate,
          metrics: [{ operation, field: "dbo.Tickets:Amount", alias: "value" }],
        },
        catalog,
        "postgres",
      ).sql,
      new RegExp(`${operation.toUpperCase()}\\(`),
    );
});
test("unavailable or invented fields are rejected", () =>
  assert.throws(
    () =>
      validateTool({ ...rows, columns: ["dbo.Tickets:Imaginary"] }, catalog),
    /not available/,
  ));
test("unjoined fields are rejected", () =>
  assert.throws(
    () => validateTool({ ...rows, columns: ["dbo.Customers:Name"] }, catalog),
    /not available/,
  ));
test("unverified joins are rejected", () =>
  assert.throws(
    () => validateTool({ ...rows, joins: ["invented"] }, catalog),
    /foreign key/,
  ));
test("fan-out joins cannot inflate metrics", () =>
  assert.throws(
    () =>
      validateTool(
        { ...aggregate, joins: ["fk_customer"] },
        {
          ...catalog,
          relationships: catalog.relationships.map((j) => ({
            ...j,
            targetUnique: false,
          })),
        },
      ),
    /uniqueness/,
  ));
test("procedure execution is not disguised as a SELECT", () =>
  assert.throws(
    () => validateTool({ ...rows, base: "dbo.SendEmail" }, catalog),
    /table or view/,
  ));
test("views are valid read-only tools", () =>
  assert.doesNotThrow(() =>
    validateTool(
      { ...rows, base: "dbo.Reports", columns: ["dbo.Reports:Total"] },
      catalog,
    ),
  ));
test("text is not silently summed", () =>
  assert.throws(
    () =>
      validateTool(
        {
          ...aggregate,
          metrics: [
            { operation: "sum", field: "dbo.Tickets:Subject", alias: "sum" },
          ],
        },
        catalog,
      ),
    /numeric/,
  ));
test("contains requires text", () =>
  assert.throws(
    () =>
      validateTool(
        {
          ...rows,
          filters: [
            {
              field: "dbo.Tickets:Id",
              operator: "contains",
              parameter: "id",
              required: false,
            },
          ],
        },
        catalog,
      ),
    /text column/,
  ));
test("SQL-bearing plan properties are rejected", () =>
  assert.throws(() =>
    validateTool({ ...rows, sql: "DELETE FROM dbo.Tickets" }, catalog),
  ));
test("duplicate outputs and filters are rejected", () => {
  assert.throws(
    () =>
      validateTool(
        { ...rows, columns: ["dbo.Tickets:Id", "dbo.Tickets:Id"] },
        catalog,
      ),
    /unique/,
  );
  assert.throws(
    () =>
      validateTool(
        {
          ...rows,
          filters: Array(2).fill({
            field: "dbo.Tickets:Id",
            operator: "eq",
            parameter: "id",
            required: false,
          }),
        },
        catalog,
      ),
    /unique/,
  );
});
test("unknown and structured parameters are rejected", () => {
  assert.throws(
    () => compileTool(rows, catalog, "postgres", { hidden: "x" }),
    /Unknown/,
  );
  assert.throws(
    () =>
      compileTool(
        {
          ...rows,
          filters: [
            {
              field: "dbo.Tickets:Id",
              operator: "eq",
              parameter: "id",
              required: false,
            },
          ],
        },
        catalog,
        "postgres",
        { id: { sql: "DELETE" } },
      ),
    /Invalid/,
  );
});
test("metadata fingerprints change when columns change", () =>
  assert.notEqual(
    fingerprint(catalog),
    fingerprint({ ...catalog, objects: [] }),
  ));
test("connection config refuses unsafe hosts and unsupported engines", () => {
  const config = {
    dialect: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "",
    database: "db",
    tls: true,
  };
  assert.doesNotThrow(() => ConnectionSchema.parse(config));
  assert.throws(() =>
    ConnectionSchema.parse({ ...config, host: "localhost/path" }),
  );
  assert.throws(() => ConnectionSchema.parse({ ...config, dialect: "oracle" }));
  assert.throws(() => ConnectionSchema.parse({ ...config, port: 0 }));
});
test("identifier quoting cannot break out into a new statement", () => {
  assert.equal(
    quote('x"; DROP TABLE t; --', "postgres"),
    '"x""; DROP TABLE t; --"',
  );
  assert.equal(quote("a]b", "sqlserver"), "[a]]b]");
  assert.equal(quote("a`b", "mysql"), "`a``b`");
});
test("credential columns are never exposed as BI tools", () => {
  const protectedCatalog = {
    ...catalog,
    objects: catalog.objects.map((o) =>
      o.id === "dbo.Tickets"
        ? {
            ...o,
            columns: [...o.columns, { name: "ApiToken", dataType: "varchar" }],
          }
        : o,
    ),
  };
  assert.throws(
    () =>
      validateTool(
        { ...rows, columns: ["dbo.Tickets:ApiToken"] },
        protectedCatalog,
      ),
    /secret columns/,
  );
});
test("SQL Server integer averages keep fractions and large sums avoid INT overflow", () => {
  const tool = {
    ...aggregate,
    metrics: [
      { operation: "avg", field: "dbo.Tickets:Id", alias: "average" },
      { operation: "sum", field: "dbo.Tickets:Id", alias: "sum" },
    ],
  };
  const result = compileTool(tool, catalog, "sqlserver");
  assert.match(result.sql, /DECIMAL\(38,6\)/);
  assert.match(result.sql, /DECIMAL\(38,0\)/);
});
