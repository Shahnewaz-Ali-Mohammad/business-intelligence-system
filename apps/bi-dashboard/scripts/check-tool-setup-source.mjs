import assert from "node:assert/strict";
import {
  listDatabases,
  discoverDatabase,
  executeTool,
  summarizeTool,
  withDatabase,
} from "../lib/tool-setup/connectors.mjs";
import { coverageTools } from "../lib/tool-setup/coverage.mjs";
import { scenarioTemplates, compileTemplateCheck } from "../lib/tool-setup/scenario-templates.mjs";
import { recordGraphPlan } from "../lib/tool-setup/graph-plan.mjs";
import { isProtectedColumn } from "../lib/tool-setup/model.mjs";

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
  if (process.argv.includes("--ai") && database === (process.env.SQLSERVER_DB_TICKETING || "TicketingDB")) {
    const master = catalog.objects.find((o) => o.kind === "table" && o.name === "DepartmentMaster");
    assert.ok(master, "Expected metadata-only generation check table must exist.");
    const safeColumns = master.columns.filter((c) => !isProtectedColumn(c.name)).slice(0, 8);
    const generationCatalog = { ...catalog, objects: [{ ...master, columns: safeColumns }], relationships: [] };
    const { generateTools, generationModel } = await import("../lib/tool-setup/generate.ts");
    const proposals = await generateTools(generationCatalog, [{ id: master.id, columns: safeColumns.map((c) => c.name) }], "Provide department record listings and counts using only the supplied schema. Do not infer the meaning of stored status values.", { signal: AbortSignal.timeout(180000), onProgress: (message) => console.log(message) });
    await withDatabase(current, async (query) => {
      for (const definition of proposals.filter((t) => t.template)) {
        const check = compileTemplateCheck(definition, generationCatalog, current.dialect);
        assert.equal((await query(check.sql, check.values)).length, 0);
      }
    });
    console.log(JSON.stringify({ liveAiGeneration: "passed", model: generationModel(), validatedProposals: proposals.length, registryWrites: 0, sourceWrites: 0 }));
    const analytics = coverageTools(generationCatalog).find((tool) => tool.mode === "aggregate");
    const key = safeColumns.find((c) => c.isPrimaryKey) || safeColumns[0];
    const summary = await summarizeTool(current, analytics, generationCatalog, { query: JSON.stringify({ groupBy: [`${master.id}:${key.name}`], metrics: [{ field: null, operation: "count", alias: "record_count" }] }) });
    assert.ok(Number(summary.population) > 1, "Streaming insight check needs multiple real groups.");
    const { writeAnalyticalInsight } = await import("./lib/analytical-insight.mjs");
    const updates = [];
    const insight = await writeAnalyticalInsight({ question: "Compare the verified department-group record counts. Explain the count distribution without inferring status meanings or business causes.", summary, signal: AbortSignal.timeout(45000), onText: (text) => updates.push(text) });
    assert.ok(insight.trim());
    assert.ok(!insight.includes("AI wording is unavailable"), "Insight returned a fallback instead of a live AI answer.");
    assert.ok(updates.length > 0, "Live insight must publish incremental checked text.");
    console.log(JSON.stringify({ liveAiInsights: "passed", incrementalUpdates: updates.length, personalRecordsSent: 0 }));
  }
  const base = catalog.objects.find(
    (o) =>
      o.kind === "table" &&
      o.name ===
        (database.toLowerCase().includes("ticket")
          ? "Tk_TicketInfoMaster"
          : "BillingMaster"),
  );
  assert.ok(base, "Expected source table must be available.");
  const selectedCatalog = { ...catalog, objects: [base], relationships: [] };
  const generated = coverageTools(selectedCatalog);
  assert.equal(generated.length, 2);
  const templates = scenarioTemplates(selectedCatalog);
  await withDatabase(current, async (query) => {
    for (const template of templates) {
      const check = compileTemplateCheck(template, selectedCatalog, current.dialect);
      const rows = await query(check.sql, check.values);
      assert.equal(rows.length, 0, "Generated templates must preflight without returning records.");
    }
  });
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
    const parameters = { record_id: result.rows[0][columns[0]] };
    const summary = await summarizeTool(current, specific, catalog, parameters);
    assert.ok(Number(summary.population) >= found.rows.length);
    const rowTool = generated.find((tool) => tool.mode === "rows");
    const analytics = generated.find((tool) => tool.mode === "aggregate");
    const plan = JSON.stringify({ columns, filters: specific.filters, values: parameters });
    const graph = recordGraphPlan(rowTool, selectedCatalog, current.dialect, plan, columns[0]);
    const grouped = await executeTool(current, analytics, selectedCatalog, { query: graph }, 2);
    assert.equal(grouped.rows.length, 1);
    assert.equal(Number(grouped.rows[0].record_count), Number(summary.population));
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
      generatedTemplatePreflights: templates.length,
      summaryAndGraph: result.rows.length ? "passed" : "not exercised: empty table",
      specificLookup: result.rows.length
        ? "passed"
        : "not exercised: empty table",
    }),
  );
}
