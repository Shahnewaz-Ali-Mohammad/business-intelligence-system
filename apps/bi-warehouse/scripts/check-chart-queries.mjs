import { querySemanticLayerPage } from '../src/services/cubeQueryService.mjs';
import { chartQueryForTool, buildChartQuery } from '../src/semantic/chartQuery.mjs';
import { getRevenueSummary } from '../src/services/revenueService.mjs';
import { getWarehousePool } from '../src/config/db.mjs';
import assert from 'node:assert/strict';

const checks = [
  ['billing by customer POP', { measures: ['IspBilling.total_billed'], dimensions: ['IspCustomer.pop_id'] }],
  ['customer counts by package', { measures: ['IspCustomer.customer_count'], dimensions: ['IspPackage.package_name'] }],
  ['ticket record IDs', { dimensions: ['IspTicket.source_ticket_id', 'IspTicket.status', 'IspTicket.opened_date'] }],
  ['transaction amounts', { dimensions: ['IspBilling.billing_sk', 'IspBilling.amount', 'IspBilling.tran_id'] }],
  ['combined financial graph', { measures: ['IspFinancial.total_billed', 'IspFinancial.total_collected', 'IspFinancial.outstanding'] }],
  ['financial ratio', { measures: ['IspFinancial.collection_rate'] }],
  ['transaction statistics', { measures: ['IspBilling.avg_transaction_amount', 'IspBilling.min_transaction_amount', 'IspBilling.max_transaction_amount'] }],
];
for (const kind of ['bar', 'line', 'heatmap']) checks.push([`ticket ${kind}`, buildChartQuery(chartQueryForTool('get_ticket_list'), { kind })]);
for (const [name, query] of checks) {
  const start = Date.now();
  try {
    const result = await querySemanticLayerPage(query, { limit: 5 });
    console.log(JSON.stringify({ name, milliseconds: Date.now() - start, rowsReturned: result.rows.length, total: result.total }));
  } catch (error) {
    console.error(JSON.stringify({ name, error: error.message }));
    process.exitCode = 1;
  }
}
try {
  const [page, summary] = await Promise.all([
    querySemanticLayerPage({ measures: ['IspFinancial.total_billed', 'IspFinancial.total_collected', 'IspFinancial.outstanding'] }, { limit: 1 }),
    getRevenueSummary(),
  ]);
  for (const [field, expected] of [['total_billed', summary.totalBilled], ['total_collected', summary.totalCollected], ['outstanding', summary.outstandingBalance]]) {
    const actual = Number(page.rows[0][`IspFinancial.${field}`]);
    assert.ok(Math.abs(actual - Number(expected)) <= Math.max(0.01, Math.abs(actual) * 1e-12), `Combined financial ${field} disagrees with warehouse totals`);
  }
  console.log(JSON.stringify({ name: 'financial totals match original services', passed: true }));
} catch (error) {
  console.error(JSON.stringify({ name: 'financial total reconciliation', error: error.message }));
  process.exitCode = 1;
} finally {
  await getWarehousePool().end();
}
