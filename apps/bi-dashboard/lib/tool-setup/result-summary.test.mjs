import test from "node:test";
import assert from "node:assert/strict";
import { compileTool } from "./model.mjs";
import { coverageTools } from "./coverage.mjs";
import { summaryQuery } from "./result-summary.mjs";
const catalog = {
  objects: [
    {
      id: "t",
      schema: "dbo",
      name: "T",
      kind: "table",
      columns: [
        { name: "Id", dataType: "int", isPrimaryKey: true },
        { name: "Amount", dataType: "decimal" },
      ],
    },
  ],
  relationships: [],
};
test("population summaries never inherit preview limits or offsets", () => {
  for (const dialect of ["postgres", "mysql", "sqlserver"]) {
    const compiled = compileTool(
      coverageTools(catalog)[0],
      catalog,
      dialect,
      {},
      100,
      100,
    );
    assert.doesNotMatch(compiled.populationSql, /TOP|LIMIT|OFFSET/);
    assert.match(compiled.sql, /OFFSET 100/);
    assert.match(summaryQuery(compiled, dialect), /population/);
    assert.match(summaryQuery(compiled, dialect, 1), /ROW_NUMBER/);
    assert.match(summaryQuery(compiled, dialect, 1), /median/);
  }
});
test("unsafe pagination offsets are rejected", () => {
  assert.throws(
    () =>
      compileTool(coverageTools(catalog)[0], catalog, "postgres", {}, 100, -1),
    /offset/,
  );
});
