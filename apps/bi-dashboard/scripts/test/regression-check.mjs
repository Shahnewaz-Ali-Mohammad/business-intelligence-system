// Automated regression test battery for the BI chatbot's real, live pipeline
// (runBiAgent -- scope gate, needs-data gate, report gate, the draft/critique
// tool-calling agent, and the semantic layer underneath it). This is NOT a
// mock/offline test like the ones used during development -- it makes real
// OpenAI calls and real MySQL queries, on purpose: it's the thing that
// closes the gap between "verified against extracted code" and "actually
// works when you use it."
//
// Run it from your own terminal, on your Mac, where OPENAI_API_KEY and the
// real MySQL connection are both reachable (this cannot be run from a cloud
// sandbox with no network route to either):
//
//   node --env-file=.env.local scripts/test/regression-check.mjs
//
// Every case here either exercises a real metric x dimension combination, or
// is a PERMANENT regression test for a bug that was found and fixed in this
// project's history -- so a future change can never silently reintroduce it
// without this script catching it. When you find a new bug, add it here as
// a new case with a comment pointing at what broke, the same way the two
// cases marked REGRESSION below do.

import { runBiAgent } from '../chat/agent.mjs';

const cases = [];
function testCase(name, message, check) {
  cases.push({ name, message, check });
}

// ---------------------------------------------------------------------
// Group A -- scope gate correctness (in-scope vs out-of-scope vs greeting)
// ---------------------------------------------------------------------
testCase('greeting: plain hello', 'hello', (r) => {
  if (r.data !== null) throw new Error('expected no data lookup for a plain greeting');
  if (!/help with/i.test(r.narrative)) throw new Error(`expected the canned capabilities reply, got: ${r.narrative}`);
});

testCase('greeting: thanks', 'thanks!', (r) => {
  if (r.data !== null) throw new Error('expected no data lookup for a thanks/acknowledgement');
});

testCase('meta: what can you help with', 'what can you help with?', (r) => {
  if (r.data !== null) throw new Error('expected no data lookup for a meta/capabilities question');
});

testCase(
  'REGRESSION (scope-gate misfire bug): real data question must NOT get the greeting reply',
  'need total revenue for each customer',
  (r) => {
    if (r.data === null) throw new Error('real data question got the greeting/no-data short-circuit -- scope gate regression');
    if (/help with revenue, orders, customers/i.test(r.narrative)) {
      throw new Error(`got the canned greeting reply for a real data question: ${r.narrative}`);
    }
  },
);

testCase(
  'REGRESSION variant (typo\'d input, exact reported bug): "need total revenue for each custoemr"',
  'need total revenue for each custoemr',
  (r) => {
    if (r.data === null) throw new Error('typo\'d real data question got the greeting/no-data short-circuit -- scope gate regression');
  },
);

testCase('out of scope: unrelated topic', 'who do you think will win the champions league?', (r) => {
  if (r.data !== null) throw new Error('expected no data lookup for an out-of-scope question');
  if (r.tablesUsed.length !== 0) throw new Error('expected empty tablesUsed for an out-of-scope decline');
});

// ---------------------------------------------------------------------
// Group B -- single metric x every dimension (the core "does it actually
// compute what was asked" matrix)
// ---------------------------------------------------------------------
testCase('metric x dimension: revenue by region', 'what is revenue by region for the last 30 days?', (r) => {
  requireBreakdown(r, 'revenue', 'region');
});
testCase('metric x dimension: order count by status', 'how many orders per status in the last 30 days?', (r) => {
  requireBreakdown(r, 'order_count', 'status');
});
testCase('metric x dimension: average order value by customer', 'average order value for each customer', (r) => {
  requireBreakdown(r, 'avg_order_value', 'customer');
});
testCase('metric x dimension: units by product', 'units sold by product', (r) => {
  requireBreakdown(r, 'units', 'product');
});
testCase('metric x dimension: revenue trend by day', 'show revenue over the last 30 days as a trend', (r) => {
  requireBreakdown(r, 'revenue', 'day');
});
testCase(
  'REGRESSION (day-breakdown bug): order count trend must NOT silently come back as revenue',
  'show me order count per day for the last 30 days',
  (r) => {
    requireBreakdown(r, 'order_count', 'day');
  },
);

// ---------------------------------------------------------------------
// Group C -- nonsense metric x dimension combos: must fall back AND say so,
// never silently mislabel the substituted metric.
// ---------------------------------------------------------------------
testCase(
  'REGRESSION (primary-metric mislabel bug): units by customer must fall back and be reported',
  'units sold for each customer',
  (r) => {
    const mb = r.data?.metricBreakdown;
    if (!mb) throw new Error('expected a metricBreakdown result');
    if (mb.primaryMetric === 'units') throw new Error('units was reported as computed per-customer, which is impossible -- mislabel bug');
    const fellBack = mb.omittedMetrics?.find((m) => m.fellBackTo);
    if (!fellBack) throw new Error('expected omittedMetrics to flag the primary-metric fallback');
    if (!/unit/i.test(r.narrative)) throw new Error(`expected the narrative to explicitly mention units couldn't be computed: ${r.narrative}`);
  },
);
testCase('average order value by product must fall back and be reported', 'average order value by product', (r) => {
  const mb = r.data?.metricBreakdown;
  if (!mb) throw new Error('expected a metricBreakdown result');
  if (mb.primaryMetric === 'avg_order_value') throw new Error('avg_order_value was reported as computed per-product, which is impossible -- mislabel bug');
});

// ---------------------------------------------------------------------
// Group D -- multiple metrics at once (same-query extras, must be
// row-aligned and never silently drop below what was asked)
// ---------------------------------------------------------------------
testCase(
  'extras: revenue + order count + avg order value per customer',
  'for each customer, show me revenue, order count, and average order value',
  (r) => {
    const mb = r.data?.metricBreakdown;
    if (!mb) throw new Error('expected a metricBreakdown result');
    if ((mb.extraMetrics?.length ?? 0) < 2) {
      throw new Error(`expected 2 extra metrics alongside the primary, got: ${JSON.stringify(mb.extraMetrics)}`);
    }
  },
);
testCase('extras: units and revenue by product', 'units and revenue by product', (r) => {
  const mb = r.data?.metricBreakdown;
  if (!mb) throw new Error('expected a metricBreakdown result');
  if ((mb.extraMetrics?.length ?? 0) < 1) throw new Error('expected at least 1 extra metric');
});

// ---------------------------------------------------------------------
// Group E -- ranking / comparison questions
// ---------------------------------------------------------------------
testCase('ranking: lowest region by revenue', 'which region has the lowest revenue?', (r) => {
  if (r.data === null) throw new Error('expected a real data lookup');
});
testCase(
  'ranking: bottom customers by order count (must run a genuinely different query, not reverse "most")',
  'who are the bottom 5 customers by number of orders?',
  (r) => {
    if (r.data === null) throw new Error('expected a real data lookup');
  },
);
testCase('comparison: this month vs last month', 'compare total revenue this month to last month', (r) => {
  if (r.data === null) throw new Error('expected a real data lookup');
  if (!r.data.periodComparison) throw new Error('expected periodComparison to be populated for a period-over-period question');
});

// ---------------------------------------------------------------------
// Group F -- report/chart requests
// ---------------------------------------------------------------------
testCase('report request: top 10 products by revenue', 'generate a report for the top 10 products by revenue', (r) => {
  if (r.intent !== 'create_new_page') throw new Error(`expected intent create_new_page, got ${r.intent}`);
  if (!r.data?.metricBreakdown) throw new Error('expected a metricBreakdown to render the report from');
});
testCase('chart format request: pie chart of orders by status', 'show me a pie chart of orders by status', (r) => {
  if (r.chartType !== 'pie') throw new Error(`expected chartType pie (explicitly requested), got ${r.chartType}`);
});

function requireBreakdown(r, expectedMetric, expectedGroupBy) {
  const mb = r.data?.metricBreakdown;
  if (!mb) throw new Error('expected a metricBreakdown result, got none');
  if (mb.groupBy !== expectedGroupBy) throw new Error(`expected groupBy "${expectedGroupBy}", got "${mb.groupBy}"`);
  if (mb.primaryMetric !== expectedMetric) {
    throw new Error(`expected primaryMetric "${expectedMetric}", got "${mb.primaryMetric}" (narrative: ${r.narrative})`);
  }
  if (!mb.rows?.length) throw new Error('expected at least one row in the breakdown');
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set -- run this with: node --env-file=.env.local scripts/test/regression-check.mjs');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const { name, message, check } of cases) {
    process.stdout.write(`RUNNING: ${name} ... `);
    try {
      const result = await runBiAgent({ message, history: [], pageState: { days: 30, region: null } });
      check(result);
      console.log('PASS');
      passed += 1;
    } catch (error) {
      console.log('FAIL');
      failed += 1;
      failures.push({ name, message, error: error.message });
    }
  }

  console.log(`\n${passed}/${cases.length} passed, ${failed} failed.\n`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}\n    message: "${f.message}"\n    ${f.error}`);
    }
    process.exit(1);
  }
}

main();
