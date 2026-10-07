import assert from 'node:assert/strict';
import { runBiAgent } from './chat/agent.mjs';
import { getWarehousePool } from '../../bi-warehouse/src/config/db.mjs';

const scenarios = [
  { name: 'exact customer record', message: 'Show the details for customer ID __BI_AUDIT_MISSING_ID__, including customer ID, name, status ID and package ID.', member: 'IspCustomer.customer_id' },
  { name: 'transaction amount and date filters', message: 'Create a report listing billing records with amount greater than 100000 during March 2026. Show billing ID, transaction ID, amount and customer ID.', member: 'IspBilling.amount' },
  { name: 'joined customer attributes', message: 'Create a report of customer counts grouped by package name and connection type.', dimension: 'IspCustomer.connection_type' },
  { name: 'full POP analytical report', message: 'give me full pop report', topic: 'pops', field: 'popFinancials' },
  { name: 'complete package analytical report', message: 'Give me a complete package performance report.', topic: 'packages', field: 'packageFinancials' },
  { name: 'full customer records', message: 'Give me a full customer report with all details.', fullCube: 'IspCustomer' },
  { name: 'full ticket records', message: 'Give me the complete ticket report with all columns.', fullCube: 'IspTicket' },
  { name: 'POP directory only', message: 'List all POP IDs and POP names only. Do not include financial metrics.', dimension: 'IspPop.pop_name', only: ['IspPop.pop_id', 'IspPop.pop_name'] },
  { name: 'filtered all customer columns', message: 'Show all columns for customer ID __BI_AUDIT_MISSING_ID__.', member: 'IspCustomer.customer_id', fullCube: 'IspCustomer' },
  { name: 'filtered all billing columns', message: 'Show full details with every available column for billing ID -999999999.', member: 'IspBilling.billing_sk', fullCube: 'IspBilling' },
  { name: 'full POP after directory', message: 'Now give me the full POP performance report, not just the names.', topic: 'pops', field: 'popFinancials', history: [{ role: 'user', content: 'List POP IDs and names only.' }, { role: 'assistant', content: '515 POP directory records.' }], pageState: { semanticQuery: { dimensions: ['IspPop.pop_id', 'IspPop.pop_name'] } } },
  { name: 'fiber tickets plain wording', message: 'give my all fiber tickets list', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5'" },
  { name: 'fiber category details wording', message: 'give all fiber tickets category details', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5'" },
  { name: 'fiber ticket count', message: 'How many Fiber Issue tickets are there?', expectedMetricSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5'" },
  { name: 'fiber typo wording', message: 'giv me all fibr issue tikets report', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5'" },
  { name: 'fiber followup after bad connection filter', message: 'I mean Fiber Issue ticket category. Give all the tickets in that category.', history: [{ role: 'user', content: 'give all fiber tickets' }, { role: 'assistant', content: 'No records match the requested filters.' }], pageState: { semanticQuery: { dimensions: ['IspTicket.source_ticket_id'], filters: [{ member: 'IspCustomer.connection_type', operator: 'equals', values: ['fiber'] }] } }, expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5'" },
  { name: 'fiber ticket date range', message: 'List all Fiber Issue tickets opened between 2025-01-01 and 2025-01-31, with every ticket column.', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '5' AND opened_date >= '2025-01-01' AND opened_date < '2025-02-01'", fullCube: 'IspTicket' },
  { name: 'active customer named status', message: 'List all customers with ACTIVE status, including all customer columns.', expectedSql: "SELECT count(*) AS n FROM dim_customer WHERE status_id = '1'", fullCube: 'IspCustomer' },
  { name: 'exact Packet Loss category not broad loss', message: 'List all tickets for the exact Packet Loss category.', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '23'" },
  { name: 'ambiguous ticket category', message: 'Show tickets with category name loss. Do not choose a specific loss category for me.', clarification: true },
  { name: 'unknown connection mapping', message: 'List tickets for customers whose connection type is fiber. I mean the customer connection field, not the Fiber Issue ticket category.', clarification: true },
  { name: 'nonexistent ticket category name', message: 'List tickets in category __NO_SUCH_CATEGORY_901__.', clarification: true },
];
const ticketSeed = await getWarehousePool().query('SELECT source_ticket_id FROM fact_ticket WHERE source_ticket_id IS NOT NULL ORDER BY ticket_sk DESC LIMIT 1');
if (ticketSeed.rows[0]) scenarios.push({ name: 'existing exact ticket ID', message: `Show full details for ticket ID ${ticketSeed.rows[0].source_ticket_id}.`, member: 'IspTicket.source_ticket_id', fullCube: 'IspTicket', expectedSql: 'SELECT count(*) AS n FROM fact_ticket WHERE source_ticket_id = $1', params: [ticketSeed.rows[0].source_ticket_id] });
const customerSeed = await getWarehousePool().query('SELECT customer_id FROM dim_customer ORDER BY customer_id LIMIT 1');
if (customerSeed.rows[0]) scenarios.push({ name: 'existing exact customer ID', message: `Show full details for customer ID ${customerSeed.rows[0].customer_id}.`, member: 'IspCustomer.customer_id', fullCube: 'IspCustomer', expectedSql: 'SELECT count(*) AS n FROM dim_customer WHERE customer_id = $1', params: [customerSeed.rows[0].customer_id] });
for (const [label, table, column, cube] of [
  ['billing', 'fact_billing', 'billing_sk', 'IspBilling'],
  ['collection', 'fact_collection', 'collection_sk', 'IspCollection'],
  ['refund', 'fact_refund', 'refund_sk', 'IspRefund'],
  ['adjustment', 'fact_adjustment', 'adjustment_sk', 'IspAdjustment'],
  ['lifecycle event', 'fact_customer_lifecycle_event', 'event_sk', 'IspCustomerLifecycleEvent'],
]) {
  const seed = await getWarehousePool().query(`SELECT ${column} AS id FROM ${table} ORDER BY ${column} DESC LIMIT 1`);
  if (seed.rows[0]) scenarios.push({ name: `existing exact ${label} warehouse row`, message: `Show every available column for the ${label} warehouse row with ${column} equal to ${seed.rows[0].id}.`, member: `${cube}.${column}`, fullCube: cube, expectedSql: `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, params: [seed.rows[0].id] });
}
scenarios.push(
  { name: 'two ticket categories OR', message: 'List all tickets whose ticket category is Fiber Issue OR Packet Loss. Include all ticket columns.', fullCube: 'IspTicket', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id IN ('5', '23')" },
  { name: 'customer status combined with connection code', message: 'List all customers whose status is ACTIVE and connection_type equals code 6. Include all customer columns.', fullCube: 'IspCustomer', expectedSql: "SELECT count(*) AS n FROM dim_customer WHERE status_id = '1' AND connection_type = '6'" },
  { name: 'unknown numeric category ID', message: 'Show all tickets with ticket_type_id equal to -999999.', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id = '-999999'" },
  { name: 'advanced category exclusion', message: 'List all tickets excluding the Fiber Issue category. Include every ticket column.', fullCube: 'IspTicket', expectedSql: "SELECT count(*) AS n FROM fact_ticket WHERE ticket_type_id <> '5'" },
  { name: 'advanced null date filter', message: 'Show all tickets where resolved_date is null, including every ticket column.', fullCube: 'IspTicket', expectedSql: 'SELECT count(*) AS n FROM fact_ticket WHERE resolved_date IS NULL' },
  { name: 'advanced numeric amount range', message: 'List all billing records whose amount is greater than or equal to 1000 and less than or equal to 1010. Include all billing columns.', fullCube: 'IspBilling', expectedSql: 'SELECT count(*) AS n FROM fact_billing WHERE amount >= 1000 AND amount <= 1010' },
);
const log = console.log;
const errorLog = console.error;
let diagnostics = [];
console.log = (...args) => { if (/gate result|fast lane|structuredResponse/.test(String(args[0]))) diagnostics.push(args.join(' ')); };
console.error = (...args) => { diagnostics.push(args.map((v) => v instanceof Error ? v.message : String(v)).join(' ')); };
try {
  for (const scenario of scenarios) {
    if (process.argv[2] && !scenario.name.includes(process.argv[2])) continue;
    diagnostics = [];
    const start = Date.now();
    try {
      const response = await runBiAgent({ message: scenario.message, history: scenario.history, pageState: scenario.pageState });
      diagnostics.push(JSON.stringify({ topic: response.topic, clarification: response.askedClarification, narrative: response.narrative, title: response.title }));
      if (scenario.clarification) {
        assert.equal(response.askedClarification, true, 'Unsupported or ambiguous value was guessed');
        assert.equal(response.data, null);
        assert.ok(!response.narrative.includes('No records match'), 'Invalid filter was presented as empty data');
        log(JSON.stringify({ name: scenario.name, milliseconds: Date.now() - start, passed: true }));
        continue;
      }
      assert.equal(response.topic, scenario.topic || 'semantic_query');
      assert.notEqual(response.title, 'Query Results');
      assert.ok(response.title?.length > 3);
      if (scenario.field) {
        assert.ok(response.data?.[scenario.field], `Missing ${scenario.field}`);
        assert.ok(!response.narrative.includes('additional pages are available'), 'Generic narrative returned');
        if (scenario.topic === 'pops' || scenario.topic === 'packages') assert.ok(response.narrative.includes('collection rate'), 'Missing analytical insight');
        if (scenario.topic === 'pops') assert.ok(response.data.popFinancials.some((r) => r.popName), 'Missing POP names');
        if (scenario.topic === 'packages') assert.ok(response.data.packageFinancials.every((r) => Number.isFinite(r.refunded) && Number.isFinite(r.adjusted)), 'Missing refund or adjustment columns');
        log(JSON.stringify({ name: scenario.name, title: response.title, milliseconds: Date.now() - start, passed: true }));
        continue;
      }
      assert.ok(response.data?.semanticQuery);
      const serialized = JSON.stringify(response.data.semanticQuery);
      if (scenario.member) assert.ok(serialized.includes(scenario.member), 'Requested filter was lost');
      if (scenario.dimension) assert.ok(serialized.includes(scenario.dimension), 'Requested grouping was lost');
      if (scenario.expectedSql || scenario.expectedMetricSql) {
        const { rows } = await getWarehousePool().query(scenario.expectedSql || scenario.expectedMetricSql, scenario.params);
        const expected = Number(rows[0].n);
        if (scenario.expectedSql) assert.equal(response.data.semanticQueryTotalCount, expected, 'AI query count differs from independent database count');
        else {
          const column = response.data.semanticQueryTable.headers.indexOf('Ticket Count');
          assert.ok(column >= 0, 'Requested metric was not returned');
          assert.equal(Number(response.data.semanticQueryTable.rows[0][column]), expected, 'AI metric differs from independent database count');
        }
        if (scenario.name.includes('fiber')) assert.ok(!JSON.stringify(response.data.semanticQuery.filters).includes('IspCustomer.connection_type'), 'Ticket category confused with connection code');
      }
      if (scenario.only) assert.deepEqual([...response.data.semanticQuery.dimensions].sort(), scenario.only.sort());
      if (scenario.fullCube) {
        const { CUBE_CATALOG } = await import('../../bi-warehouse/src/semantic/cubeCatalog.mjs');
        for (const column of CUBE_CATALOG.find((c) => c.name === scenario.fullCube).dimensions) assert.ok(response.data.semanticQuery.dimensions.includes(column.name), `Missing full-detail column ${column.name}`);
      }
      if (response.data.semanticQueryTotalCount > 5) assert.ok(response.narrative.includes('full matching dataset'), 'Missing full-set summary');
      if (scenario.name === 'transaction amount and date filters') {
        assert.ok(serialized.includes('2026-03-01'));
        assert.ok(serialized.includes('2026-03-31'));
      }
      log(JSON.stringify({ name: scenario.name, milliseconds: Date.now() - start, total: response.data.semanticQueryTotalCount, previewRows: response.data.semanticQueryTable?.rows.length, passed: true }));
    } catch (error) {
      errorLog(JSON.stringify({ name: scenario.name, milliseconds: Date.now() - start, error: error.message, diagnostics }));
      process.exitCode = 1;
    }
  }
} finally {
  console.log = log;
  console.error = errorLog;
  await getWarehousePool().end();
}
