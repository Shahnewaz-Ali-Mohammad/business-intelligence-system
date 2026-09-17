// ============================================================================
// Semantic metrics registry — THE single source of truth for what every
// metric name means. Every consumer (dashboard, chatbot/MCP tools,
// reports, exports) must go through the service functions in
// src/services/*, which in turn use ONLY this file's SQL fragments.
// No consumer is allowed to write its own version of a metric's formula.
//
// Each metric defines:
//   - sql: the SQL expression to SUM/AGGREGATE, written against the
//     warehouse fact table it belongs to
//   - table: which fact table it's computed from
//   - validDimensions: the only columns/joins this metric is allowed to be
//     grouped/broken down by — prevents nonsensical combinations (e.g.
//     nobody should be able to ask for customer_count broken down by
//     something it was never designed to support)
// ============================================================================

// Dimensions that live directly on the fact table's own columns.
// 'pop_id' is handled separately — see JOIN_DIMENSIONS below — because
// fact_billing/fact_collection.pop_id is always NULL (BillingMaster, the
// source table, has no POP column at all; confirmed against real
// INFORMATION_SCHEMA.COLUMNS output, not assumed). The only real way to
// get a customer's POP is via dim_customer.pop_id, which IS populated for
// 385,965 of 386,063 customers (99.97%, confirmed against real data).
// FIX 2026-09-17: BUG FOUND LIVE (chat-errors.log: "column reference
// customer_id is ambiguous") -- this map used to apply its join to EVERY
// metric grouped by that dimension name, with no regard for whether the
// metric's own table already had that column directly. Two real breaks
// resulted: (1) active_customer_count (table dim_customer, which already
// HAS pop_id as a real direct column) grouped by pop_id triggered a
// needless SELF-join of dim_customer to itself, and active_customer_count's
// SQL uses bare unqualified `customer_id`/`status_id` -- with two copies of
// dim_customer in the query, Postgres can no longer tell which one that
// means, hence the ambiguous-column error. (2) total_billed/total_collected
// (fact_billing/fact_collection, which have a REAL, direct, ETL-synced
// package_id column) grouped by package_id silently started resolving
// package_id via the customer's CURRENT package instead of the real
// transactional package_id already on that row -- wrong data, not just an
// error. `appliesToTables` fixes both: the join only fires for tables that
// genuinely lack the column directly; everywhere else falls through to the
// existing plain (no-join) path, which is correct because those tables
// already have the real column.
export const JOIN_DIMENSIONS = {
  pop_id: {
    table: 'dim_customer',
    alias: 'dc',
    on: 'customer_id',
    column: 'pop_id',
    // fact_billing/fact_collection/fact_refund/fact_adjustment/fact_ticket
    // all genuinely lack a direct pop_id column (confirmed against
    // warehouse-schema.sql) -- dim_customer itself is deliberately NOT
    // listed here, since it already has pop_id directly.
    appliesToTables: ['fact_billing', 'fact_collection', 'fact_refund', 'fact_adjustment', 'fact_ticket'],
  },
  // dim_customer.package_id is a real, populated column (confirmed against
  // warehouse-schema.sql) -- fact_refund/fact_adjustment genuinely lack a
  // direct package_id of their own (unlike fact_billing/fact_collection,
  // which have a real synced package_id column and must NOT be in this
  // list). HONESTY NOTE, same caveat as pop_id: this is the customer's
  // CURRENT package at query time, not necessarily whatever package was
  // active on the date of a given refund/adjustment row.
  package_id: {
    table: 'dim_customer',
    alias: 'dcp',
    on: 'customer_id',
    column: 'package_id',
    appliesToTables: ['fact_refund', 'fact_adjustment'],
  },
};

export const METRICS = {
  total_billed: {
    table: 'fact_billing',
    sql: 'SUM(amount)',
    validDimensions: ['ref_date', 'pop_id', 'package_id', 'ref_type_name', 'customer_id'],
    label: 'Total Billed',
  },
  total_collected: {
    table: 'fact_collection',
    sql: 'SUM(amount)',
    // FIX 2026-09-17: package_id added -- fact_collection.package_id is now
    // real (BillingMaster.BID was always fetched for collection rows too,
    // just never carried through the ETL mapping until now -- see
    // billingMaster.mjs and warehouse-schema.sql's matching fixes). Collected
    // amount CAN genuinely be broken down by package now.
    validDimensions: ['ref_date', 'pop_id', 'tran_mode_name', 'package_id', 'customer_id', 'tran_mode_id'],
    label: 'Total Collected',
  },
  total_refunded: {
    table: 'fact_refund',
    sql: 'SUM(amount)',
    validDimensions: ['ref_date', 'pop_id', 'customer_id', 'package_id'],
    label: 'Total Refunded',
  },
  total_adjusted: {
    table: 'fact_adjustment',
    sql: 'SUM(amount)',
    validDimensions: ['ref_date', 'pop_id', 'customer_id', 'package_id'],
    label: 'Total Adjusted',
  },
  // outstanding_balance is a derived metric (billed - collected) — it spans
  // two fact tables, so it's computed in src/services/revenueService.js by
  // calling total_billed and total_collected separately and subtracting,
  // rather than expressed as one SQL fragment here.

  active_customer_count: {
    table: 'dim_customer',
    // Confirmed against real dim_status data: status_id is numeric (mirrors
    // CustomerMaster.StatusID), and status_id = 1 maps to status_name
    // 'ACTIVE'. The original draft compared status_id to the string
    // 'ACTIVE' directly, which would never match a numeric id — fixed here
    // after checking the real dim_status table (27 rows, all confirmed).
    sql: `COUNT(DISTINCT customer_id) FILTER (WHERE status_id = '1')`,
    validDimensions: ['pop_id', 'package_id'],
    label: 'Active Customers',
  },

  ticket_volume: {
    table: 'fact_ticket',
    sql: 'COUNT(*)',
    // UPDATED 2026-09-17: customer_id and pop_id added -- fact_ticket has a
    // real, direct customer_id column (confirmed against
    // warehouse-schema.sql), and pop_id resolves the same JOIN_DIMENSIONS
    // way as everywhere else (via dim_customer.pop_id).
    validDimensions: ['department_id', 'ticket_type_id', 'opened_date', 'customer_id', 'pop_id'],
    label: 'Ticket Volume',
  },
  // NOT YET USABLE: resolved_date is always NULL right now — no confirmed
  // "ticket resolved" column exists on the real source table
  // (Tk_TicketInfoMaster). StatusChangeDate looked like a candidate but was
  // never verified to specifically mean resolution, not just any status
  // change (see src/etl/tables/tickets.mjs header). This metric is defined
  // so the shape exists, but it will return NULL until that source column
  // question is resolved — it is NOT hidden or faked with a fallback value.
  avg_resolution_hours: {
    table: 'fact_ticket',
    sql: `AVG(EXTRACT(EPOCH FROM (resolved_date - opened_date)) / 3600.0) FILTER (WHERE resolved_date IS NOT NULL)`,
    validDimensions: ['department_id', 'ticket_type_id', 'customer_id', 'pop_id'],
    label: 'Avg Resolution Time (hours) — unavailable, see comment',
  },
};

export function getMetric(name) {
  const metric = METRICS[name];
  if (!metric) throw new Error(`Unknown metric: ${name}`);
  return metric;
}

export function assertValidDimension(metricName, dimension) {
  const metric = getMetric(metricName);
  if (dimension && !metric.validDimensions.includes(dimension)) {
    throw new Error(
      `Metric "${metricName}" cannot be broken down by "${dimension}". Valid dimensions: ${metric.validDimensions.join(', ')}`
    );
  }
}
