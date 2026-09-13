import http from 'node:http';
import mysql from 'mysql2/promise';

const port = Number(process.env.API_PORT ?? 4100);

const dbConfig = {
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? 'ecommerce',
  user: process.env.DB_USER ?? 'bi_readonly',
  password: process.env.DB_PASSWORD ?? 'bi_demo_password',
};

const colors = ['#0f9f9a', '#2563eb', '#7c3aed', '#f59e0b', '#94a3b8'];
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

// A shared connection POOL, created once per process, instead of a brand
// new mysql.createConnection() (its own TCP handshake + auth round trip)
// on every single dashboardData() call. A chat turn that generates a
// report calls dashboardData() at least twice (once inside the MCP tool
// while the agent reasons, once again to build the render dataset), and a
// busy dashboard/chat under real traffic calls it constantly -- paying a
// fresh connection setup cost every time doesn't scale. Pooled connections
// are acquired and released (never destroyed) per call below.
let pool = null;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...dbConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

function toNumber(value) {
  return Number(value ?? 0);
}

function sparklineFrom(values) {
  if (!values.length) {
    return [20, 20, 20, 20, 20, 20];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return values.map(() => 42);
  }

  return values.map((value) => Math.round(18 + ((value - min) / (max - min)) * 54));
}

// Zero-floor version: scales from 0 (not the data's own minimum) up to the max, so
// the chart shows the real proportional shape of the data instead of stretching a
// small real range to fill the whole plot height.
function zeroFloorFrom(values) {
  if (!values.length) {
    return [20, 20, 20, 20, 20, 20];
  }

  const max = Math.max(...values, 0);

  if (max === 0) {
    return values.map(() => 18);
  }

  return values.map((value) => Math.round(18 + (Math.max(value, 0) / max) * 54));
}

function axisFrom(values, xStart, xEnd, formatter = (value) => String(value), options = {}) {
  if (!values.length) {
    return {
      xStart,
      xEnd,
      yMin: formatter(0),
      yMax: formatter(0),
    };
  }

  const yMin = options.zeroFloor ? 0 : Math.min(...values);

  return {
    xStart,
    xEnd,
    yMin: formatter(yMin),
    yMax: formatter(Math.max(...values)),
  };
}

function chartPointsFrom(rows, valueKey, formatter, options = {}) {
  const values = rows.map((row) => toNumber(row[valueKey]));
  const normalize = options.zeroFloor ? zeroFloorFrom : sparklineFrom;
  const normalized = normalize(values);

  return rows.map((row, index) => ({
    label: row.day ?? row.region ?? `Point ${index + 1}`,
    value: formatter(values[index] ?? 0),
    normalized: normalized[index] ?? 42,
  }));
}

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function computeAnomalies(trendRows) {
  const metrics = [
    {
      label: 'Revenue',
      values: trendRows.map((row) => toNumber(row.revenue)),
      format: (value) => money.format(value),
    },
    {
      label: 'Orders',
      values: trendRows.map((row) => Number(row.orders)),
      format: (value) => `${Math.round(value).toLocaleString('en-US')}`,
    },
    {
      label: 'Average Order Value',
      values: trendRows.map((row) =>
        Number(row.orders) ? toNumber(row.revenue) / Number(row.orders) : 0,
      ),
      format: (value) => money.format(value),
    },
  ];

  const candidates = [];

  for (const metric of metrics) {
    const values = metric.values;
    if (values.length < 2) continue;

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (!mean || !stdDev) continue;

    values.forEach((value, index) => {
      const deltaPct = ((value - mean) / mean) * 100;
      const zScore = (value - mean) / stdDev;

      candidates.push({
        label: metric.label,
        date: trendRows[index].day,
        value: metric.format(value),
        deltaPct,
        zScore,
      });
    });
  }

  candidates.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return candidates.slice(0, 4).map((candidate) => {
    const rounded = Math.round(candidate.deltaPct * 10) / 10;
    const status =
      rounded <= -15 ? 'critical' : rounded < 0 ? 'warning' : rounded >= 15 ? 'success' : 'info';

    return [
      candidate.label,
      candidate.date,
      candidate.value,
      `${rounded > 0 ? '+' : ''}${rounded}%`,
      status,
    ];
  });
}

const CUSTOMER_COLUMN_CANDIDATES = ['customer_id', 'user_id', 'buyer_id', 'account_id', 'client_id'];
const ALLOWED_TOPICS = [
  'revenue',
  'orders',
  'customers',
  'products',
  'regions',
  'status',
  'shipping',
];

// Which real tables actually back each topic's answer -- surfaced to the UI so
// the user can see exactly what the reply is grounded in, never guessed by the
// model itself.
const TOPIC_TABLES = {
  revenue: ['orders'],
  orders: ['orders'],
  customers: ['users', 'orders'],
  products: ['order_items'],
  regions: ['orders'],
  status: ['orders', 'order_status_history'],
  shipping: ['orders'],
  dashboard: ['orders', 'users', 'order_items', 'order_status_history'],
};

function tablesForTopic(topic) {
  return TOPIC_TABLES[topic] ?? TOPIC_TABLES.dashboard;
}

async function findOrdersCustomerColumn(connection) {
  const rows = await readOnlyQuery(
    connection,
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
    `,
  );
  const names = new Set(rows.map((row) => row.COLUMN_NAME));
  return CUSTOMER_COLUMN_CANDIDATES.find((candidate) => names.has(candidate)) ?? null;
}

async function computeCustomerMix(connection, windowCutoff) {
  try {
    const fkCol = await findOrdersCustomerColumn(connection);
    if (!fkCol || !windowCutoff) return null;

    const rows = await readOnlyQuery(
      connection,
      `
        SELECT
          SUM(CASE WHEN first_order >= ? THEN 1 ELSE 0 END) AS new_customers,
          SUM(CASE WHEN first_order < ? THEN 1 ELSE 0 END) AS returning_customers
        FROM (
          SELECT ${fkCol} AS cid, MIN(ordered_at) AS first_order, MAX(ordered_at) AS last_order
          FROM orders
          WHERE ${fkCol} IS NOT NULL
          GROUP BY ${fkCol}
          HAVING last_order >= ?
        ) recent_customers
      `,
      [windowCutoff, windowCutoff, windowCutoff],
    );

    const newCustomers = Number(rows[0]?.new_customers ?? 0);
    const returningCustomers = Number(rows[0]?.returning_customers ?? 0);
    const total = newCustomers + returningCustomers;
    if (!total) return null;

    return {
      newCustomers,
      returningCustomers,
      newPct: Math.round((newCustomers / total) * 1000) / 10,
      returningPct: Math.round((returningCustomers / total) * 1000) / 10,
    };
  } catch (error) {
    console.error('customer mix query failed, falling back to null:', error.message);
    return null;
  }
}

async function findPrimaryKeyColumn(connection, table) {
  const rows = await readOnlyQuery(
    connection,
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI'
      LIMIT 1
    `,
    [table],
  );
  return rows[0]?.COLUMN_NAME ?? null;
}

const NAME_COLUMN_CANDIDATES = ['full_name', 'name', 'display_name', 'customer_name', 'username'];

async function findUsersDisplayName(connection) {
  const rows = await readOnlyQuery(
    connection,
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    `,
  );
  const names = new Set(rows.map((row) => row.COLUMN_NAME));

  const single = NAME_COLUMN_CANDIDATES.find((candidate) => names.has(candidate));
  if (single) return { type: 'single', column: single };

  if (names.has('first_name') && names.has('last_name')) {
    return { type: 'combo', columns: ['first_name', 'last_name'] };
  }

  if (names.has('email')) return { type: 'single', column: 'email' };

  return null;
}

// Customers with more than one order ALL-TIME (not window-scoped -- a customer's
// repeat orders are often spread across months, so restricting to the 30-day
// window hid almost everyone). Falls back to an empty list (never throws) if we
// can't confidently find a customer-linking column, a users primary key, or any
// recognizable name/email column on this schema.
async function computeRepeatCustomers(connection) {
  try {
    const fkCol = await findOrdersCustomerColumn(connection);
    if (!fkCol) {
      console.warn('[repeatCustomers] no customer-linking column found on orders');
      return [];
    }

    const usersPk = await findPrimaryKeyColumn(connection, 'users');
    const nameInfo = await findUsersDisplayName(connection);
    if (!usersPk || !nameInfo) {
      console.warn('[repeatCustomers] missing users primary key or name column', {
        usersPk,
        nameInfo,
      });
      return [];
    }

    const nameExpr =
      nameInfo.type === 'combo'
        ? `TRIM(CONCAT(u.${nameInfo.columns[0]}, ' ', u.${nameInfo.columns[1]}))`
        : `u.${nameInfo.column}`;

    const rows = await readOnlyQuery(
      connection,
      `
        SELECT
          ${nameExpr} AS customer_name,
          COUNT(*) AS order_count,
          SUM(o.grand_total) AS revenue,
          MAX(o.ordered_at) AS last_order
        FROM orders o
        JOIN users u ON u.${usersPk} = o.${fkCol}
        GROUP BY o.${fkCol}, ${nameExpr}
        HAVING order_count > 1
        ORDER BY order_count DESC, revenue DESC
        LIMIT 8
      `,
    );

    console.log(`[repeatCustomers] fkCol=${fkCol} usersPk=${usersPk} rows=${rows.length}`);

    return rows.map((row) => [
      row.customer_name || 'Unknown customer',
      `${row.order_count} orders`,
      money.format(toNumber(row.revenue)),
      row.last_order
        ? new Date(row.last_order).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '\u2014',
    ]);
  } catch (error) {
    console.error('repeat customers query failed, falling back to empty list:', error.message);
    return [];
  }
}

// Customers ranked by total number of orders placed (all-time), for a
// horizontal bar ranking. direction: 'DESC' (top/most, default) or 'ASC'
// (bottom/least) -- these are genuinely different SQL queries, never derived
// by reversing the other's results, since the bottom-N customers by order
// count are a completely different set of rows than the top-N. Falls back
// to an empty list (never throws) if we can't confidently resolve the
// customer link / name columns.
async function computeTopCustomersByOrders(connection, direction = 'DESC', limit = 10, windowCutoff = null) {
  try {
    const fkCol = await findOrdersCustomerColumn(connection);
    if (!fkCol) return [];

    const usersPk = await findPrimaryKeyColumn(connection, 'users');
    const nameInfo = await findUsersDisplayName(connection);
    if (!usersPk || !nameInfo) return [];

    const nameExpr =
      nameInfo.type === 'combo'
        ? `TRIM(CONCAT(u.${nameInfo.columns[0]}, ' ', u.${nameInfo.columns[1]}))`
        : `u.${nameInfo.column}`;

    const safeDirection = direction === 'ASC' ? 'ASC' : 'DESC';
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 10;
    // Every other figure in the same bundle (revenueTrend, region, status)
    // is scoped to the active day window -- this one was not, so it silently
    // returned each customer's ALL-TIME order count while everything else on
    // screen (and the flexible per-customer breakdown the chat agent also
    // queries) described "last N days." Both numbers were real, which is
    // exactly why a chat narrative that picked this field instead of the
    // windowed metricBreakdown looked plausible but described a completely
    // different, unbounded time range -- reproducibly, since this query has
    // no randomness. Scope it the same way the rest of the bundle already does.
    const windowClause = windowCutoff ? 'WHERE DATE(o.ordered_at) >= ?' : '';
    const windowParam = windowCutoff ? [windowCutoff] : [];

    const rows = await readOnlyQuery(
      connection,
      `
        SELECT
          ${nameExpr} AS customer_name,
          COUNT(*) AS order_count
        FROM orders o
        JOIN users u ON u.${usersPk} = o.${fkCol}
        ${windowClause}
        GROUP BY o.${fkCol}, ${nameExpr}
        ORDER BY order_count ${safeDirection}
        LIMIT ${safeLimit}
      `,
      windowParam,
    );

    return rows.map((row) => ({
      name: row.customer_name || 'Unknown customer',
      orders: Number(row.order_count),
    }));
  } catch (error) {
    console.error('top customers by orders query failed, falling back to empty list:', error.message);
    return [];
  }
}

// A flexible, whitelisted metric-breakdown query builder. This is what lets
// the chatbot answer arbitrary "X by Y" questions (revenue by status, order
// count by customer, units by product, etc.) and genuinely join tables
// (orders + users for customer breakdowns) instead of only ever returning
// the same fixed dashboard bundle. The LLM never writes SQL -- it can only
// pick from these enum-validated metric/groupBy/sortDirection/limit values,
// which map to a small set of pre-written, parameterized queries. Every
// query here is still read-only and capped by LIMIT.
const METRIC_EXPR = {
  orders: {
    revenue: 'COALESCE(SUM(o.grand_total), 0)',
    order_count: 'COUNT(*)',
    avg_order_value: 'COALESCE(AVG(o.grand_total), 0)',
  },
  order_items: {
    revenue: 'COALESCE(SUM(oi.line_total), 0)',
    units: 'COALESCE(SUM(oi.qty), 0)',
    order_count: 'COUNT(DISTINCT oi.order_id)',
  },
};

// Builds "<expr> AS value, <expr2> AS extra_0, <expr3> AS extra_1" -- extra
// metrics computed in the SAME query as the primary one, on the SAME
// grouped rows. This is what lets "revenue AND order count per customer"
// come back as one consistent table instead of two separately-sorted,
// separately-limited queries that can (and did) return different customer
// sets in different orders, forcing the model to either drop numbers or
// mismatch them across rows.
function buildMetricSelectList(exprTable, metric, extraMetrics, fallbackMetric) {
  // The PRIMARY metric can itself be unsupported for this dimension (e.g.
  // metric:"units" requested with groupBy:"customer" -- there's no
  // line-item table to sum units from on that join, only
  // order_items/product has one). That used to silently fall back to
  // fallbackMetric while every caller kept labeling the result with the
  // ORIGINALLY REQUESTED metric name -- so a "units by customer" request
  // would come back as a table of real order-count numbers mislabeled
  // "Units", which is worse than an omission: it's a wrong, confidently
  // presented number. primaryMetricUsed/primaryMetricFellBack let every
  // caller label the result with what was ACTUALLY computed and still
  // flag the substitution explicitly, instead of mislabeling it.
  const primarySupported = Boolean(exprTable[metric]);
  const primaryMetricUsed = primarySupported ? metric : fallbackMetric;
  const primaryExpr = exprTable[primaryMetricUsed];
  const requested = extraMetrics ?? [];
  // Two different reasons a requested extra metric can fail to make it into
  // the query, and callers need to know which happened: "unsupported" means
  // the metric genuinely cannot be computed for this dimension at all (e.g.
  // "units" requested for a customer/region/status breakdown -- there's no
  // line-item table to sum units from there, only order_items/product has
  // one). "droppedForCap" means it was a valid metric but more than 2 extras
  // were requested at once. Both used to be silently dropped with zero
  // signal anywhere -- the model would happily answer with fewer columns
  // than it was actually asked for and never mention it, so a request for
  // "revenue, order count, average order value, AND units per customer"
  // quietly became a 3-column answer with no acknowledgement that units
  // was never a real option for that breakdown.
  const unsupported = requested.filter((m) => m !== metric && !exprTable[m]);
  const usable = requested.filter((m) => exprTable[m] && m !== metric);
  const validExtras = usable.slice(0, 2);
  const droppedForCap = usable.slice(2);
  const extraCols = validExtras.map((m, i) => `${exprTable[m]} AS extra_${i}`);
  return {
    selectSql: [`${primaryExpr} AS value`, ...extraCols].join(', '),
    extraMetricNames: validExtras,
    omittedMetricNames: [...unsupported, ...droppedForCap],
    primaryMetricRequested: metric,
    primaryMetricUsed,
    primaryMetricFellBack: !primarySupported,
  };
}

function attachExtras(row, extraMetricNames) {
  if (!extraMetricNames.length) return {};
  const extras = {};
  extraMetricNames.forEach((metricName, i) => {
    extras[metricName] = toNumber(row[`extra_${i}`]);
  });
  return extras;
}

// Computes the same top-line totals (revenue, order count, AOV) for the
// window immediately BEFORE the current one -- e.g. current window is the
// last 30 days, this returns the 30 days before that, region-scoped the
// same way as the main request. This is what "vs last month", "vs last
// week", "compare to the previous period" questions need: a single query
// against the real prior window, never two independent trailing-N-days
// calls (which both measure from "now" and can't express a distinct
// earlier period at all) and never a number estimated/guessed by the model.
async function computePreviousPeriod(connection, { windowDays, windowCutoff, regionClause, regionParam }) {
  if (!windowCutoff) return null;
  const rows = await readOnlyQuery(
    connection,
    `
      SELECT
        COALESCE(SUM(grand_total), 0) AS revenue,
        COUNT(*) AS order_count,
        DATE_FORMAT(DATE_SUB(?, INTERVAL ? DAY), '%b %e') AS prevStartLabel,
        DATE_FORMAT(DATE_SUB(?, INTERVAL 1 DAY), '%b %e') AS prevEndLabel
      FROM orders
      WHERE DATE(ordered_at) >= DATE_SUB(?, INTERVAL ? DAY)
        AND DATE(ordered_at) < ?
        ${regionClause}
    `,
    [windowCutoff, windowDays, windowCutoff, windowCutoff, windowDays, windowCutoff, ...regionParam],
  );
  const row = rows[0] ?? {};
  const revenue = toNumber(row.revenue);
  const orderCount = Number(row.order_count ?? 0);
  return {
    revenue,
    orderCount,
    avgOrderValue: orderCount ? revenue / orderCount : 0,
    label:
      row.prevStartLabel && row.prevEndLabel
        ? row.prevStartLabel.trim() === row.prevEndLabel.trim()
          ? row.prevStartLabel.trim()
          : `${row.prevStartLabel.trim()} - ${row.prevEndLabel.trim()}`
        : 'Previous period',
  };
}

async function computeMetricBreakdown(
  connection,
  { metric = 'revenue', extraMetrics = [], groupBy = 'region', sortDirection = 'most', limit = 10, windowCutoff, regionClause, regionParam },
) {
  const safeDirection = sortDirection === 'least' ? 'ASC' : 'DESC';
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 10;

  // No try/catch swallowing errors into a fake "empty" result here anymore.
  // A genuine query failure now propagates up to dashboardDataUncached()'s
  // own catch, which already logs full detail server-side and converts it
  // into one sanitized, honest error message -- the same path a DB-down
  // failure takes. Silently returning { rows: [] } used to make a real bug
  // in one specific breakdown query look exactly like "there's no data for
  // that", which is a much worse failure mode than a visible error: it's
  // indistinguishable from a correct, empty answer.
  if (groupBy === 'region') {
      const { selectSql, extraMetricNames, omittedMetricNames, primaryMetricUsed, primaryMetricFellBack } =
        buildMetricSelectList(METRIC_EXPR.orders, metric, extraMetrics, 'revenue');
      const rows = await readOnlyQuery(
        connection,
        `
          SELECT COALESCE(ship_country_code, 'Other') AS name, ${selectSql}
          FROM orders o
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY COALESCE(ship_country_code, 'Other')
          ORDER BY value ${safeDirection}
          LIMIT ${safeLimit}
        `,
        [windowCutoff, ...regionParam],
      );
      return {
        rows: rows.map((r) => ({ name: r.name, value: toNumber(r.value), extras: attachExtras(r, extraMetricNames) })),
        extraMetricNames,
        omittedMetricNames,
        primaryMetricUsed,
        primaryMetricFellBack,
        tablesUsed: ['orders'],
      };
    }

    if (groupBy === 'status') {
      const { selectSql, extraMetricNames, omittedMetricNames, primaryMetricUsed, primaryMetricFellBack } =
        buildMetricSelectList(METRIC_EXPR.orders, metric, extraMetrics, 'order_count');
      const rows = await readOnlyQuery(
        connection,
        `
          SELECT status AS name, ${selectSql}
          FROM orders o
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY status
          ORDER BY value ${safeDirection}
          LIMIT ${safeLimit}
        `,
        [windowCutoff, ...regionParam],
      );
      return {
        rows: rows.map((r) => ({ name: r.name, value: toNumber(r.value), extras: attachExtras(r, extraMetricNames) })),
        extraMetricNames,
        omittedMetricNames,
        primaryMetricUsed,
        primaryMetricFellBack,
        tablesUsed: ['orders'],
      };
    }

    if (groupBy === 'day') {
      // Used to hardcode SUM(grand_total) (revenue) no matter what metric
      // was actually requested -- "order count by day" or "average order
      // value trend" silently came back as a revenue trend mislabeled with
      // whatever metric name the model asked for. buildMetricSelectList is
      // the same real fix used for every other dimension: compute whatever
      // was actually asked for (with the same documented, reported fallback
      // when it's genuinely unsupported), instead of a second, inconsistent
      // hardcoded path that only ever silently returned revenue.
      const { selectSql, extraMetricNames, omittedMetricNames, primaryMetricUsed, primaryMetricFellBack } =
        buildMetricSelectList(METRIC_EXPR.orders, metric, extraMetrics, 'revenue');
      const rows = await readOnlyQuery(
        connection,
        `
          SELECT DATE_FORMAT(ordered_at, '%b %e') AS name, ${selectSql}
          FROM orders o
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY DATE(ordered_at), DATE_FORMAT(ordered_at, '%b %e')
          ORDER BY DATE(ordered_at) ASC
          LIMIT ${safeLimit}
        `,
        [windowCutoff, ...regionParam],
      );
      return {
        rows: rows.map((r) => ({ name: r.name, value: toNumber(r.value), extras: attachExtras(r, extraMetricNames) })),
        extraMetricNames,
        omittedMetricNames,
        primaryMetricUsed,
        primaryMetricFellBack,
        tablesUsed: ['orders'],
      };
    }

    if (groupBy === 'product') {
      const { selectSql, extraMetricNames, omittedMetricNames, primaryMetricUsed, primaryMetricFellBack } =
        buildMetricSelectList(METRIC_EXPR.order_items, metric, extraMetrics, 'revenue');
      const rows = await readOnlyQuery(
        connection,
        `
          SELECT oi.product_name AS name, ${selectSql}
          FROM order_items oi
          GROUP BY oi.product_name
          ORDER BY value ${safeDirection}
          LIMIT ${safeLimit}
        `,
      );
      return {
        rows: rows.map((r) => ({ name: r.name, value: toNumber(r.value), extras: attachExtras(r, extraMetricNames) })),
        extraMetricNames,
        omittedMetricNames,
        primaryMetricUsed,
        primaryMetricFellBack,
        tablesUsed: ['order_items'],
      };
    }

    if (groupBy === 'customer') {
      const fkCol = await findOrdersCustomerColumn(connection);
      const usersPk = await findPrimaryKeyColumn(connection, 'users');
      const nameInfo = await findUsersDisplayName(connection);
      if (!fkCol || !usersPk || !nameInfo) return { rows: [], extraMetricNames: [], omittedMetricNames: [], primaryMetricUsed: metric, primaryMetricFellBack: false, tablesUsed: ['orders', 'users'] };

      const nameExpr =
        nameInfo.type === 'combo'
          ? `TRIM(CONCAT(u.${nameInfo.columns[0]}, ' ', u.${nameInfo.columns[1]}))`
          : `u.${nameInfo.column}`;
      const { selectSql, extraMetricNames, omittedMetricNames, primaryMetricUsed, primaryMetricFellBack } =
        buildMetricSelectList(METRIC_EXPR.orders, metric, extraMetrics, 'order_count');

      const rows = await readOnlyQuery(
        connection,
        `
          SELECT ${nameExpr} AS name, ${selectSql}
          FROM orders o
          JOIN users u ON u.${usersPk} = o.${fkCol}
          WHERE DATE(o.ordered_at) >= ? ${regionClause}
          GROUP BY o.${fkCol}, ${nameExpr}
          ORDER BY value ${safeDirection}
          LIMIT ${safeLimit}
        `,
        [windowCutoff, ...regionParam],
      );
      return {
        rows: rows.map((r) => ({ name: r.name || 'Unknown customer', value: toNumber(r.value), extras: attachExtras(r, extraMetricNames) })),
        extraMetricNames,
        omittedMetricNames,
        primaryMetricUsed,
        primaryMetricFellBack,
        tablesUsed: ['orders', 'users'],
      };
    }

  return {
    rows: [],
    extraMetricNames: [],
    omittedMetricNames: [],
    primaryMetricUsed: metric,
    primaryMetricFellBack: false,
    tablesUsed: [],
  };
}

const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

async function readOnlyQuery(connection, sql, params = []) {
  if (!sql.trim().toLowerCase().startsWith('select')) {
    throw new Error('Only read-only SELECT queries are allowed.');
  }

  const [rows] = await connection.execute(sql, params);
  return rows;
}

const METRIC_LABELS = {
  revenue: 'Revenue',
  units: 'Units',
  order_count: 'Orders',
  avg_order_value: 'Avg Order Value',
};

// A single chat turn that generates a report calls dashboardData() at
// least twice with the EXACT same parameters -- once inside the MCP tool
// while the agent reasons, once again afterward to build the full render
// dataset (the tool result even computed and attached a `_fullData` field
// with this same data, but nothing downstream ever reads it, since MCP's
// result schema doesn't carry arbitrary extra fields back through the
// protocol reliably). Rather than rely on threading that raw object through
// MCP/LangChain plumbing, an identical call within a short window is served
// from this small in-process cache instead of re-querying the database --
// same effect (one real DB round trip per unique request instead of two),
// much simpler to reason about and verify. The TTL is intentionally short:
// this is a live dashboard, not a place staleness should live for long.
const DASHBOARD_DATA_CACHE_TTL_MS = 5_000;
const DASHBOARD_DATA_CACHE_MAX_ENTRIES = 50;
const dashboardDataCache = new Map();

function cacheKeyFor(params) {
  const { windowDays = 30, region = null, customerSort = 'most', metricQueries = [], comparePreviousPeriod = false } = params ?? {};
  return JSON.stringify({ windowDays, region, customerSort, metricQueries, comparePreviousPeriod });
}

async function dashboardData(params) {
  const key = cacheKeyFor(params);
  const cached = dashboardDataCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < DASHBOARD_DATA_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await dashboardDataUncached(params);

  // A successful result is cached; a promise that rejected is not stored --
  // there's nothing useful to serve back to a second identical caller.
  dashboardDataCache.set(key, { at: now, value });
  if (dashboardDataCache.size > DASHBOARD_DATA_CACHE_MAX_ENTRIES) {
    const oldestKey = dashboardDataCache.keys().next().value;
    dashboardDataCache.delete(oldestKey);
  }
  return value;
}

async function dashboardDataUncached({
  windowDays = 30,
  region = null,
  customerSort = 'most',
  metricQueries = [],
  comparePreviousPeriod = false,
} = {}) {
  // The whole body -- including the connection attempt itself -- is inside
  // this try now, not just the queries. Previously mysql.createConnection()
  // ran OUTSIDE the try/finally: if the DB was down or unreachable, its raw
  // driver error (connect ECONNREFUSED <host>:<port>, auth failure detail,
  // etc.) propagated completely unmodified -- all the way up through the
  // MCP tool call into the LLM's tool-result content, where the model could
  // read and potentially repeat real infrastructure detail back to the user
  // in its narrative, despite the guardrail prompt telling it never to
  // reveal infrastructure. A prompt instruction can't reliably stop a model
  // from relaying text it was directly handed as "the tool result" -- so
  // the raw detail is stopped here, at the source, before the model ever
  // sees it: logged in full server-side, replaced with one generic message
  // for every caller (the MCP tool, the /api/dashboard route, the chat
  // agent) to handle the same way a "no data yet" case would.
  let connection;
  try {
    connection = await getPool().getConnection();
    await connection.query('SET SESSION TRANSACTION READ ONLY');

    const WINDOW_DAYS = windowDays;
    // Label the window from the actual requested range (cutoff -> latest
    // order date), NOT from which days happen to have orders in them --
    // GROUP BY DATE(ordered_at) below silently drops zero-order days, so
    // deriving the label from that result set understates the window (e.g.
    // "last 5 days" with no orders on the first 2 days used to render as
    // "May 4 - May 6" instead of the true "May 2 - May 6").
    const [cutoffRows] = await connection.execute(
      `SELECT
         DATE_SUB(DATE(MAX(ordered_at)), INTERVAL ? DAY) AS cutoff,
         DATE_FORMAT(DATE_SUB(DATE(MAX(ordered_at)), INTERVAL ? DAY), '%b %e') AS cutoffLabel,
         DATE_FORMAT(MAX(ordered_at), '%b %e') AS windowEndLabel
       FROM orders`,
      [WINDOW_DAYS - 1, WINDOW_DAYS - 1],
    );
    const windowCutoff = cutoffRows[0]?.cutoff ?? null;
    const windowCutoffLabel = cutoffRows[0]?.cutoffLabel?.trim() ?? null;
    const windowEndLabel = cutoffRows[0]?.windowEndLabel?.trim() ?? null;
    const regionClause = region ? 'AND ship_country_code = ?' : '';
    const regionParam = region ? [region] : [];

    const [
      customerRows,
      trendRows,
      regionRows,
      productRows,
      channelRows,
      statusHistoryRows,
      exportRows,
    ] = await Promise.all([
      readOnlyQuery(connection, 'SELECT COUNT(*) AS value FROM users WHERE is_active = TRUE'),
      readOnlyQuery(
        connection,
        `
          SELECT
            DATE(ordered_at) AS raw_day,
            DATE_FORMAT(ordered_at, '%b %e') AS day,
            COALESCE(SUM(grand_total), 0) AS revenue,
            COUNT(*) AS orders
          FROM orders
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY DATE(ordered_at), DATE_FORMAT(ordered_at, '%b %e')
          ORDER BY DATE(ordered_at) ASC
        `,
        [windowCutoff, ...regionParam],
      ),
      readOnlyQuery(
        connection,
        `
          SELECT
            COALESCE(ship_country_code, 'Other') AS region,
            COALESCE(SUM(grand_total), 0) AS revenue
          FROM orders
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY COALESCE(ship_country_code, 'Other')
          ORDER BY revenue DESC
          LIMIT 5
        `,
        [windowCutoff, ...regionParam],
      ),
      readOnlyQuery(
        connection,
        `
          SELECT
            product_name AS product,
            COALESCE(SUM(line_total), 0) AS revenue,
            COALESCE(SUM(qty), 0) AS orders,
            COALESCE(AVG(unit_price), 0) AS aov
          FROM order_items
          GROUP BY product_name
          ORDER BY revenue DESC
          LIMIT 5
        `,
      ),
      readOnlyQuery(
        connection,
        `
          SELECT status AS label, COUNT(*) AS value
          FROM orders
          WHERE DATE(ordered_at) >= ? ${regionClause}
          GROUP BY status
          ORDER BY value DESC
          LIMIT 5
        `,
        [windowCutoff, ...regionParam],
      ),
      readOnlyQuery(
        connection,
        `
          SELECT status AS title, MAX(changed_at) AS changed_at, COUNT(*) AS total
          FROM order_status_history
          GROUP BY status
          ORDER BY changed_at DESC
          LIMIT 4
        `,
      ),
      readOnlyQuery(
        connection,
        `
          SELECT
            DATE_FORMAT(ordered_at, '%Y_%m') AS export_month,
            COUNT(*) AS total_orders
          FROM orders
          GROUP BY DATE_FORMAT(ordered_at, '%Y_%m')
          ORDER BY export_month DESC
          LIMIT 3
        `,
      ),
    ]);

    const activeCustomers = Number(customerRows[0]?.value ?? 0);
    const trendRevenue = trendRows.map((row) => toNumber(row.revenue));
    const trendOrders = trendRows.map((row) => Number(row.orders));
    const trendAov = trendRows.map((row) =>
      Number(row.orders) ? toNumber(row.revenue) / Number(row.orders) : 0,
    );
    // Revenue/order totals are scoped to the same window as the trend chart below them,
    // so the big KPI number and the sparkline always describe the same period.
    const totalRevenue = trendRevenue.reduce((sum, value) => sum + value, 0);
    const totalOrders = trendOrders.reduce((sum, value) => sum + value, 0);
    const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;
    // Same label used for the top-line dateRange field below -- shared
    // here so periodComparison.current.label always matches it exactly.
    const dateRangeLabelForComparison =
      windowCutoffLabel && windowEndLabel
        ? windowCutoffLabel === windowEndLabel
          ? windowCutoffLabel
          : `${windowCutoffLabel} - ${windowEndLabel}`
        : (trendRows[0]?.day ?? 'No orders');
    const topRegion = regionRows[0]?.region ?? 'All regions';
    const activeFilterLabel = region ?? 'All regions';
    const xStart = trendRows[0]?.day ?? 'Start';
    const xEnd = trendRows[trendRows.length - 1]?.day ?? 'End';
    const customerMix = await computeCustomerMix(connection, windowCutoff);
    const customerMixPlaceholder = customerMix
      ? `${customerMix.newPct}% new / ${customerMix.returningPct}% returning (last ${WINDOW_DAYS} days)`
      : 'New vs returning not available for this schema';
    const repeatCustomers = await computeRepeatCustomers(connection);
    const topCustomersByOrders = await computeTopCustomersByOrders(
      connection,
      customerSort === 'least' ? 'ASC' : 'DESC',
      10,
      windowCutoff,
    );

    // Optional flexible "X by Y" breakdown requested by the MCP tool --
    // e.g. revenue by status, order count by customer. Kept separate from
    // the fixed dashboard bundle above so existing charts/KPIs are
    // unaffected when this isn't requested.
    //
    // When the user wants more than one number per entity (e.g. revenue AND
    // order count per customer), the tool call carries extraMetrics and
    // computeMetricBreakdown computes ALL of them in ONE SQL query on the
    // SAME grouped/sorted/limited rows -- this is what guarantees the
    // numbers can't mismatch or come from two different customer sets, which
    // is what happened when this used to be two separate queries merged by
    // name afterward.
    let metricBreakdown = null;
    const previousPeriod = comparePreviousPeriod
      ? await computePreviousPeriod(connection, { windowDays: WINDOW_DAYS, windowCutoff, regionClause, regionParam })
      : null;
    if (metricQueries.length) {
      const [primary, ...rest] = metricQueries;
      const primaryResult = await computeMetricBreakdown(connection, {
        metric: primary.metric,
        extraMetrics: primary.extraMetrics ?? [],
        groupBy: primary.groupBy,
        sortDirection: primary.sortDirection,
        limit: primary.limit,
        windowCutoff,
        regionClause,
        regionParam,
      });

      // Same-query extras (guaranteed row-aligned) become the primary
      // source of extra columns.
      const extraMetrics = primaryResult.extraMetricNames.map((metricName) => ({
        metric: metricName,
        label: METRIC_LABELS[metricName] ?? metricName,
        valuesByName: Object.fromEntries(primaryResult.rows.map((r) => [r.name, r.extras[metricName]])),
        tablesUsed: primaryResult.tablesUsed,
      }));

      // Backward-compat: if the agent still issues genuinely separate calls
      // (rest) on the same dimension instead of using extraMetrics, merge
      // them in too -- best-effort, not guaranteed row-aligned, and skipped
      // for any metric already covered by the same-query extras above.
      const alreadyCovered = new Set(primaryResult.extraMetricNames);
      for (const query of rest) {
        if (query.groupBy !== primary.groupBy || alreadyCovered.has(query.metric) || query.metric === primary.metric) continue;
        const extraResult = await computeMetricBreakdown(connection, {
          metric: query.metric,
          groupBy: query.groupBy,
          sortDirection: query.sortDirection,
          limit: 50, // pull enough rows to cover the primary's names even if sorted differently
          windowCutoff,
          regionClause,
          regionParam,
        });
        const valuesByName = Object.fromEntries(extraResult.rows.map((r) => [r.name, r.value]));
        extraMetrics.push({
          metric: query.metric,
          label: METRIC_LABELS[query.metric] ?? query.metric,
          valuesByName,
          tablesUsed: extraResult.tablesUsed,
        });
        alreadyCovered.add(query.metric);
      }

      // primaryResult.primaryMetricUsed is what the query ACTUALLY computed
      // -- if the requested primary metric wasn't supported for this
      // dimension (e.g. metric:"units" with groupBy:"customer"), it fell
      // back to a real, correctly-labeled metric instead of the query
      // silently returning that fallback's numbers mislabeled with the
      // originally-requested metric's name. The label/primaryMetric below
      // always describe what the rows genuinely contain.
      const primaryMetricUsed = primaryResult.primaryMetricUsed ?? primary.metric;
      const omittedMetrics = (primaryResult.omittedMetricNames ?? []).map((metricName) => ({
        metric: metricName,
        label: METRIC_LABELS[metricName] ?? metricName,
      }));
      if (primaryResult.primaryMetricFellBack) {
        omittedMetrics.unshift({
          metric: primary.metric,
          label: METRIC_LABELS[primary.metric] ?? primary.metric,
          fellBackTo: METRIC_LABELS[primaryMetricUsed] ?? primaryMetricUsed,
        });
      }

      metricBreakdown = {
        rows: primaryResult.rows.map((r) => ({ name: r.name, value: r.value })),
        primaryMetric: primaryMetricUsed,
        primaryLabel: METRIC_LABELS[primaryMetricUsed] ?? primaryMetricUsed,
        groupBy: primary.groupBy,
        extraMetrics,
        // Metrics the caller asked for (via extraMetrics, or as the PRIMARY
        // metric itself) that this dimension genuinely cannot compute at
        // all, or that were dropped only because more than 2 extras were
        // requested at once -- e.g. "units" has no meaning for a
        // customer/region/status breakdown, only for products. Surfaced
        // explicitly instead of silently vanishing or silently swapped in
        // for a differently-labeled number, so the agent can (and must, per
        // its guardrail prompt) say so in the narrative rather than quietly
        // answering with fewer, or the wrong, numbers than it was actually
        // asked for.
        omittedMetrics,
        tablesUsed: [
          ...new Set([...primaryResult.tablesUsed, ...extraMetrics.flatMap((m) => m.tablesUsed)]),
        ],
      };
    }

    return {
      connected: true,
      source: `ecommerce via bi_readonly (last ${trendRows.length} order days${region ? `, ${region} only` : ''})`,
      activeFilter: activeFilterLabel,
      promptSuggestion: `Ask about ${topRegion}, ${productRows[0]?.product ?? 'top products'}, or ${channelRows[0]?.label ?? 'order status'} orders`,
      chartSources: {
        trend: `orders.ordered_at + orders.grand_total (last ${WINDOW_DAYS} days)`,
        region: `orders.ship_country_code + orders.grand_total (last ${WINDOW_DAYS} days)`,
        channel: `orders.status (last ${WINDOW_DAYS} days)`,
        products: 'order_items.product_name + order_items.line_total (all-time)',
        anomalies: `orders.grand_total variance (last ${WINDOW_DAYS} days)`,
      },
      customerMix,
      repeatCustomers,
      topCustomersByOrders,
      kpis: [
        {
          label: 'Revenue',
          value: compactMoney.format(totalRevenue),
          delta: `${trendRows.length} order days in range`,
          trend: 'up',
          accent: '#0f9f9a',
          sparkline: zeroFloorFrom(trendRevenue),
          chartPoints: chartPointsFrom(trendRows, 'revenue', money.format, { zeroFloor: true }),
          source: 'payments.status = captured (scoped to chart range)',
          detail: `${money.format(totalRevenue)} captured revenue in this range`,
          context: `${totalOrders.toLocaleString('en-US')} orders included`,
          footer: `Highest daily revenue: ${money.format(Math.max(...trendRevenue))}`,
          axis: axisFrom(trendRevenue, xStart, xEnd, compactMoney.format, { zeroFloor: true }),
        },
        {
          label: 'Orders',
          value: totalOrders.toLocaleString('en-US'),
          delta: `${trendRows.length} active order dates`,
          trend: 'up',
          accent: '#2563eb',
          sparkline: zeroFloorFrom(trendOrders),
          chartPoints: chartPointsFrom(
            trendRows,
            'orders',
            (value) => `${value.toLocaleString('en-US')} orders`,
            { zeroFloor: true },
          ),
          source: 'orders table count (scoped to chart range)',
          detail: `${totalOrders.toLocaleString('en-US')} orders in this range`,
          context: `${regionRows.length} shipping regions in top view`,
          footer: `Busiest day: ${Math.max(...trendOrders).toLocaleString('en-US')} orders`,
          axis: axisFrom(
            trendOrders,
            xStart,
            xEnd,
            (value) => `${value.toLocaleString('en-US')} orders`,
            { zeroFloor: true },
          ),
        },
        {
          label: 'Active Customers',
          value: activeCustomers.toLocaleString('en-US'),
          delta: `${activeCustomers.toLocaleString('en-US')} active user rows`,
          trend: 'up',
          accent: '#7c3aed',
          sparkline: [],
          chartPoints: [],
          source: 'users.is_active = true',
          detail: `${activeCustomers.toLocaleString('en-US')} active customers`,
          context: customerMixPlaceholder,
          footer: `Average revenue/customer: ${money.format(activeCustomers ? totalRevenue / activeCustomers : 0)}`,
          axis: {
            xStart: 'New',
            xEnd: 'Returning',
            yMin: '0%',
            yMax: '100%',
          },
        },
        {
          label: 'Average Order Value',
          value: money.format(avgOrderValue),
          delta: `${money.format(avgOrderValue)} per order`,
          trend: 'down',
          accent: '#f97316',
          sparkline: zeroFloorFrom(trendAov),
          chartPoints: trendRows.map((row, index) => ({
            label: row.day,
            value: money.format(trendAov[index] ?? 0),
            normalized: zeroFloorFrom(trendAov)[index] ?? 42,
          })),
          source: 'payments revenue / orders',
          detail: `${money.format(totalRevenue)} / ${totalOrders.toLocaleString('en-US')} orders`,
          context: `${productRows[0]?.product ?? 'Top product'} leads product revenue`,
          footer: `Top product AOV: ${money.format(toNumber(productRows[0]?.aov))}`,
          axis: axisFrom(trendAov, xStart, xEnd, money.format, { zeroFloor: true }),
        },
      ],
      revenueTrend: trendRows.map((row) => ({
        day: row.day,
        revenue: toNumber(row.revenue),
        orders: Number(row.orders),
      })),
      dateRange:
        windowCutoffLabel && windowEndLabel
          ? windowCutoffLabel === windowEndLabel
            ? windowCutoffLabel
            : `${windowCutoffLabel} - ${windowEndLabel}`
          : (trendRows[0]?.day ?? 'No orders'),
      regionRevenue: regionRows.map((row) => ({
        region: row.region ?? 'Other',
        revenue: toNumber(row.revenue),
      })),
      channelRevenue: channelRows.map((row, index) => ({
        name: row.label,
        value: Number(row.value),
        fill: colors[index] ?? '#64748b',
      })),
      topProductsChart: productRows.slice(0, 8).map((row) => ({
        name: row.product,
        revenue: toNumber(row.revenue),
      })),
      topProducts: productRows.map((row) => [
        row.product,
        compactMoney.format(toNumber(row.revenue)),
        `${Math.round((toNumber(row.revenue) / totalRevenue) * 1000) / 10}%`,
        Number(row.orders).toLocaleString('en-US'),
        money.format(toNumber(row.aov)),
        'ecommerce',
      ]),
      anomalies: computeAnomalies(trendRows),
      pinnedPages: regionRows.slice(0, 4).map((row) => ({
        title: `${row.region ?? 'Other'} Region`,
        meta: compactMoney.format(toNumber(row.revenue)),
        status: 'Live',
      })),
      sessionHistory: statusHistoryRows.map((row) => ({
        title: `${row.title} Orders`,
        meta: `${row.total} status records`,
        status: 'Live',
      })),
      exportsList: exportRows.map(
        (row) => `Orders_${row.export_month}_${row.total_orders}_records`,
      ),
      metricBreakdown,
      periodComparison: previousPeriod
        ? {
            current: { label: dateRangeLabelForComparison, revenue: totalRevenue, orderCount: totalOrders, avgOrderValue },
            previous: previousPeriod,
          }
        : null,
    };
  } catch (error) {
    console.error('[dashboardData] query failed:', error);
    throw new Error('The data source is temporarily unavailable. Please try again in a moment.');
  } finally {
    // release() returns the connection to the pool for reuse -- end()
    // would close the underlying TCP connection entirely, defeating the
    // point of pooling.
    if (connection) connection.release();
  }
}


export {
  dbConfig,
  toNumber,
  compactMoney,
  readOnlyQuery,
  dashboardData,
  ALLOWED_TOPICS,
  TOPIC_TABLES,
  tablesForTopic,
};
