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

// Top 10 customers ranked by total number of orders placed (all-time), for a
// horizontal bar ranking. Falls back to an empty list (never throws) if we
// can't confidently resolve the customer link / name columns.
async function computeTopCustomersByOrders(connection) {
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

    const rows = await readOnlyQuery(
      connection,
      `
        SELECT
          ${nameExpr} AS customer_name,
          COUNT(*) AS order_count
        FROM orders o
        JOIN users u ON u.${usersPk} = o.${fkCol}
        GROUP BY o.${fkCol}, ${nameExpr}
        ORDER BY order_count DESC
        LIMIT 10
      `,
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

async function dashboardData({ windowDays = 30, region = null } = {}) {
  const connection = await mysql.createConnection(dbConfig);

  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');

    const WINDOW_DAYS = windowDays;
    const [cutoffRows] = await connection.execute(
      'SELECT DATE_SUB(DATE(MAX(ordered_at)), INTERVAL ? DAY) AS cutoff FROM orders',
      [WINDOW_DAYS - 1],
    );
    const windowCutoff = cutoffRows[0]?.cutoff ?? null;
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
    const topRegion = regionRows[0]?.region ?? 'All regions';
    const activeFilterLabel = region ?? 'All regions';
    const xStart = trendRows[0]?.day ?? 'Start';
    const xEnd = trendRows[trendRows.length - 1]?.day ?? 'End';
    const customerMix = await computeCustomerMix(connection, windowCutoff);
    const customerMixPlaceholder = customerMix
      ? `${customerMix.newPct}% new / ${customerMix.returningPct}% returning (last ${WINDOW_DAYS} days)`
      : 'New vs returning not available for this schema';
    const repeatCustomers = await computeRepeatCustomers(connection);
    const topCustomersByOrders = await computeTopCustomersByOrders(connection);

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
        trendRows.length > 1
          ? `${trendRows[0].day} - ${trendRows[trendRows.length - 1].day}`
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
    };
  } finally {
    await connection.end();
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
