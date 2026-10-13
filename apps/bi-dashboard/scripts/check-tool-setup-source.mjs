import assert from "node:assert/strict";
import {
  listDatabases,
  discoverDatabase,
  executeTool,
} from "../lib/tool-setup/connectors.mjs";

// Reads existing source metadata and bounded SELECT results only. No app/source writes or AI calls.
if (
  !process.env.SQLSERVER_HOST ||
  !process.env.SQLSERVER_USER ||
  !process.env.SQLSERVER_PASSWORD
)
  throw new Error("Load the existing warehouse SQL Server environment first.");
const config = {
  dialect: "sqlserver",
  host: process.env.SQLSERVER_HOST,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  username: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  database: "master",
  tls: true,
  trustServerCertificate: true,
};
// Reuse the existing source connection's certificate setting for this read-only check.
const databases = await listDatabases(config);
for (const database of [
  process.env.SQLSERVER_DB_TICKETING || "TicketingDB",
  process.env.SQLSERVER_DB_BILLING || "billGENIXDB",
]) {
  assert.ok(
    databases.includes(database),
    "Expected source database must be accessible.",
  );
  const current = { ...config, database };
  const catalog = await discoverDatabase(current);
  assert.ok(catalog.objects.length > 0);
  const base = catalog.objects.find(
    (o) =>
      o.kind === "table" &&
      o.name ===
        (database.toLowerCase().includes("ticket")
          ? "Tk_TicketInfoMaster"
          : "BillingMaster"),
  );
  assert.ok(base, "Expected source table must be available.");
  const columns = base.columns.slice(0, 2).map((c) => `${base.id}:${c.name}`);
  const definition = {
    name: "source_read_check",
    description: "Bounded read-only source connection check.",
    base: base.id,
    joins: [],
    mode: "rows",
    columns,
    groupBy: [],
    metrics: [],
    filters: [],
  };
  const result = await executeTool(current, definition, catalog, {}, 2);
  assert.ok(result.rows.length <= 2);
  assert.deepEqual(
    Object.keys(result.rows[0] || {}),
    result.rows.length ? columns : [],
  );
  if (result.rows.length && result.rows[0][columns[0]] !== null) {
    const specific = {
      ...definition,
      filters: [
        {
          field: columns[0],
          operator: "eq",
          parameter: "record_id",
          required: true,
        },
      ],
    };
    const found = await executeTool(
      current,
      specific,
      catalog,
      { record_id: result.rows[0][columns[0]] },
      2,
    );
    assert.ok(
      found.rows.length > 0,
      "Specific-value lookup must return a matching record.",
    );
  }
  console.log(
    JSON.stringify({
      database,
      objects: catalog.objects.length,
      views: catalog.objects.filter((o) => o.kind === "view").length,
      procedures: catalog.objects.filter((o) => o.kind === "procedure").length,
      verifiedRelationships: catalog.relationships.filter((j) => j.targetUnique)
        .length,
      boundedRead: "passed",
      specificLookup: result.rows.length
        ? "passed"
        : "not exercised: empty table",
    }),
  );
}
