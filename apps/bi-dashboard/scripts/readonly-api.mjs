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

const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, `http://localhost:${port}`);

  if (requestUrl.pathname === '/api/chat' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message ?? '').slice(0, 500);
        const pageState = payload.page_state ?? {};
        const result = await handleChatMessage(message, pageState);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Could not handle chat request',
          }),
        );
      }
    });
    return;
  }

  if (requestUrl.pathname !== '/api/dashboard' || request.method !== 'GET') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Both params are always sent as query-string params (never string-interpolated
  // into SQL) -- readOnlyQuery uses parameterized placeholders throughout -- but we
  // still validate their shape here so a stray value can't silently no-op the filter.
  const rawDays = Number(requestUrl.searchParams.get('days'));
  const windowDays = Number.isInteger(rawDays) && rawDays > 0 && rawDays <= 365 ? rawDays : 30;

  const rawRegion = requestUrl.searchParams.get('region');
  const region = rawRegion && /^[A-Za-z]{2,10}$/.test(rawRegion) ? rawRegion.toUpperCase() : null;

  try {
    const data = await dashboardData({ windowDays, region });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Database read failed',
      }),
    );
  }
});

server.listen(port, () => {
  console.log(`Read-only BI API listening at http://localhost:${port}/api/dashboard`);
});

function parseDays(message, fallbackDays) {
  const lower = message.toLowerCase();
  const explicit = lower.match(/last\s+(\d{1,3})\s*(day|days|d)\b/);
  if (explicit) {
    const days = Number(explicit[1]);
    if (Number.isInteger(days) && days > 0 && days <= 365) return days;
  }
  if (lower.includes('week') || lower.includes('7 day')) return 7;
  if (lower.includes('month') || lower.includes('30 day')) return 30;
  if (lower.includes('quarter') || lower.includes('90 day')) return 90;
  if (lower.includes('year') || lower.includes('365 day')) return 365;
  return fallbackDays;
}

function parseRegion(message, pageState) {
  const lower = message.toLowerCase();
  if (lower.includes('all region') || lower.includes('all countries') || lower.includes('clear region')) {
    return null;
  }

  const currentRegions = Array.isArray(pageState.availableRegions)
    ? pageState.availableRegions.map((region) => String(region).toUpperCase())
    : [];

  for (const region of currentRegions) {
    if (lower.includes(region.toLowerCase())) return region;
  }

  const regionMatch = lower.match(/\b(us|de|at|br|fr|uk|ca|au|in|bd)\b/);
  return regionMatch ? regionMatch[1].toUpperCase() : pageState.region ?? null;
}

function detectTopic(message) {
  const lower = message.toLowerCase();
  return ALLOWED_TOPICS.find((topic) => lower.includes(topic)) ?? 'dashboard';
}

function isCasualChat(message) {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
  return [
    'hi',
    'hello',
    'hey',
    'yo',
    'thanks',
    'thank you',
    'ok',
    'okay',
  ].includes(normalized);
}

function detectIntent(message) {
  const lower = message.toLowerCase();
  if (isCasualChat(message)) return 'answer';

  const answerWords = [
    'what is',
    'what does',
    'explain',
    'define',
    'why',
    'how is',
    'how do',
    'how many',
    'how much',
    'tell me',
    'summarize',
    'what are',
    'which',
  ];
  if (answerWords.some((word) => lower.includes(word))) return 'answer';

  const createWords = [
    'create',
    'generate',
    'build',
    'make',
    'show chart',
    'show graph',
    'new page',
    'new report',
    'new dashboard',
    'breakdown',
    'visualize',
    'plot',
  ];
  if (createWords.some((word) => lower.includes(word))) return 'create_new_page';

  const mutateWords = ['filter', 'switch', 'change', 'update', 'only', 'last ', 'region'];
  if (mutateWords.some((word) => lower.includes(word))) return 'mutate_current_page';

  return 'answer';
}

function fallbackPlan(message, pageState) {
  const fallbackDays = Number(pageState.days ?? 30);
  return {
    intent: detectIntent(message),
    topic: detectTopic(message),
    days: parseDays(message, fallbackDays),
    region: parseRegion(message, pageState),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function planWithOpenAI(message, pageState) {
  if (!process.env.OPENAI_API_KEY) return fallbackPlan(message, pageState);

  const fallback = fallbackPlan(message, pageState);
  const availableRegions = Array.isArray(pageState.availableRegions)
    ? pageState.availableRegions.map((region) => String(region).toUpperCase())
    : [];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: openAiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You classify BI dashboard user requests. Return only JSON. Never write SQL. Allowed intents: answer, mutate_current_page, create_new_page. Use answer for greetings, casual chat, definitions, explanations, simple factual questions, summaries, and "what does X mean". Use create_new_page only when the user clearly asks to create/generate/build/show a new chart, graph, report, dashboard, page, visualization, or breakdown. Use mutate_current_page only for direct filter/refinement requests such as changing date range or region. Allowed topics: revenue, orders, customers, products, regions, status, shipping, dashboard. Region must be null or one of the available region codes. Days must be one of 7, 30, 90, 365 unless the user explicitly asks a number from 1 to 365.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              message,
              currentPageState: {
                days: pageState.days ?? 30,
                region: pageState.region ?? null,
                availableRegions,
                kpis: pageState.kpis ?? [],
                chartSources: pageState.chartSources ?? {},
              },
              requiredJsonShape: {
                intent: 'answer | mutate_current_page | create_new_page',
                topic: 'revenue | orders | customers | products | regions | status | shipping | dashboard',
                days: 'number',
                region: 'string | null',
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) return fallback;

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? '';
    const plan = safeJsonParse(content) ?? fallback;
    if (fallback.intent === 'answer') {
      return fallback;
    }
    const intent = ['answer', 'mutate_current_page', 'create_new_page'].includes(plan.intent)
      ? plan.intent
      : fallback.intent;
    const topic = ALLOWED_TOPICS.includes(plan.topic) ? plan.topic : fallback.topic;
    const parsedDays = Number(plan.days);
    const days =
      Number.isInteger(parsedDays) && parsedDays > 0 && parsedDays <= 365
        ? parsedDays
        : fallback.days;
    const region =
      plan.region === null || plan.region === undefined
        ? null
        : availableRegions.includes(String(plan.region).toUpperCase())
          ? String(plan.region).toUpperCase()
          : fallback.region;

    return { intent, topic, days, region };
  } catch (error) {
    console.error('OpenAI planning failed, using deterministic fallback:', error.message);
    return fallback;
  }
}

function answerFromComputedData(message, plan, data) {
  const lower = message.toLowerCase();
  const revenue = data.kpis.find((kpi) => kpi.label === 'Revenue')?.value ?? 'unknown revenue';
  const orders = data.kpis.find((kpi) => kpi.label === 'Orders')?.value ?? 'unknown orders';
  const customers =
    data.kpis.find((kpi) => kpi.label === 'Active Customers')?.value ?? 'unknown customers';
  const aov = data.kpis.find((kpi) => kpi.label === 'Average Order Value')?.value ?? 'unknown AOV';
  const scope = `${plan.region ?? 'all regions'} over ${plan.days} days`;

  if (isCasualChat(message)) {
    return 'Hi. I can answer questions from the ecommerce database, explain the KPI numbers, or create a new analysis view when you ask for a chart, breakdown, or report.';
  }
  if (lower.includes('changed_at')) {
    return 'changed_at is the timestamp for when a record changed state. In order_status_history, it means when an order moved into a status such as pending, paid, cancelled, or delivered.';
  }
  if (lower.includes('average order value') || lower.includes('aov')) {
    return `Average Order Value is revenue divided by orders. For ${scope}, AOV is ${aov}, calculated from ${revenue} and ${orders} orders.`;
  }
  if (lower.includes('revenue')) {
    return `Revenue for ${scope} is ${revenue}. This comes from captured payment/order totals in the read-only ecommerce database.`;
  }
  if (lower.includes('customer')) {
    return `The users table currently has ${customers} active customers. Repeat-customer details come from linked order history where the schema supports it.`;
  }
  if (lower.includes('status')) {
    const statusText = data.channelRevenue
      .map((row) => `${row.name}: ${row.value}`)
      .join(', ');
    return `Order status counts for ${scope}: ${statusText}.`;
  }
  if (lower.includes('product')) {
    const asksLowest = /\b(lowest|worst|least|bottom|smallest|weakest)\b/.test(lower);
    if (asksLowest && data.topProducts.length) {
      const worst = data.topProducts[data.topProducts.length - 1];
      return `The lowest-performing product (all-time) is ${worst[0]} at ${worst[1]}. This comes from order_items revenue rollups, not scoped to ${plan.days} days.`;
    }
    const products = data.topProducts
      .slice(0, 3)
      .map((row) => `${row[0]} (${row[1]})`)
      .join(', ');
    return `Top products (all-time): ${products}. These values come from order_items revenue rollups and are not scoped to ${plan.days} days.`;
  }
  if (lower.includes('region')) {
    const regions = data.regionRevenue
      .slice(0, 5)
      .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
      .join(', ');
    if (lower.includes('how many')) {
      return `There are ${data.regionRevenue.length} regions in the current DB result: ${data.regionRevenue.map((row) => row.region).join(', ')}.`;
    }

    // Superlative questions ("which region has the lowest/highest sales")
    // must answer directly, not just dump the whole breakdown.
    const asksLowest = /\b(lowest|worst|least|bottom|smallest|weakest)\b/.test(lower);
    const asksHighest = /\b(highest|best|top|most|biggest|largest|leading)\b/.test(lower);
    if ((asksLowest || asksHighest) && data.regionRevenue.length) {
      const sorted = [...data.regionRevenue].sort((a, b) => toNumber(a.revenue) - toNumber(b.revenue));
      const target = asksLowest ? sorted[0] : sorted[sorted.length - 1];
      const label = asksLowest ? 'lowest' : 'highest';
      return `The ${label} sales region for ${scope} is ${target.region}, at ${compactMoney.format(toNumber(target.revenue))}. Full breakdown: ${regions}.`;
    }

    return `Revenue by region for ${scope}: ${regions}.`;
  }
  return `For ${scope}, revenue is ${revenue}, orders are ${orders}, active customers are ${customers}, and average order value is ${aov}.`;
}

// Topic-specific, grounded report text. Each branch only reads the sub-slice of
// `data` that topic actually maps to, so "products" never talks about regions and
// vice versa -- this used to collapse to one generic paragraph for every topic,
// which is the main reason chat replies felt inaccurate/generic.
function reportFromComputedData(plan, data) {
  const scope = `${plan.region ?? 'all regions'}, ${plan.days} day window`;
  const findKpi = (label) => data.kpis.find((kpi) => kpi.label === label);
  const revenueKpi = findKpi('Revenue');
  const ordersKpi = findKpi('Orders');
  const aovKpi = findKpi('Average Order Value');
  const customersKpi = findKpi('Active Customers');

  switch (plan.topic) {
    case 'revenue': {
      if (!revenueKpi) return `No revenue data was returned for ${scope}.`;
      return `Revenue report for ${scope}: total revenue is ${revenueKpi.value}. ${revenueKpi.detail}. ${revenueKpi.footer} Source: orders.grand_total, captured payments only.`;
    }

    case 'orders': {
      if (!ordersKpi) return `No order data was returned for ${scope}.`;
      return `Order volume report for ${scope}: ${ordersKpi.value} orders placed. ${ordersKpi.detail}. ${ordersKpi.footer} Source: orders table row count.`;
    }

    case 'customers': {
      const mixSentence = data.customerMix
        ? `${data.customerMix.newPct}% of active-window customers are new and ${data.customerMix.returningPct}% are returning.`
        : 'New-vs-returning split is not available on this schema.';
      const topCustomerSentence =
        data.topCustomersByOrders.length > 0
          ? `Top repeat customer: ${data.topCustomersByOrders[0].name} with ${data.topCustomersByOrders[0].orders} orders.`
          : 'No repeat-customer rows were found (no customer-linking column detected, or no repeat orders).';
      return `Customer report for ${scope}: ${customersKpi?.value ?? 'unknown'} active customers. ${mixSentence} ${topCustomerSentence} Source: users.is_active joined to orders.`;
    }

    case 'products': {
      if (data.topProducts.length === 0) return `No product revenue rows were returned for ${scope}.`;
      const lines = data.topProducts
        .slice(0, 5)
        .map((row) => `${row[0]}: ${row[1]} revenue (${row[2]} share, ${row[3]} units)`)
        .join('; ');
      return `Product report (all-time, not scoped to ${plan.days} days -- order_items has no verified date column): ${lines}. Source: order_items.product_name + line_total.`;
    }

    case 'regions': {
      if (data.regionRevenue.length === 0) return `No regional revenue rows were returned for ${scope}.`;
      const lines = data.regionRevenue
        .slice(0, 5)
        .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
        .join(', ');
      return `Regional revenue report for ${scope}: ${lines}. Source: orders.ship_country_code + grand_total.`;
    }

    case 'status': {
      if (data.channelRevenue.length === 0) return `No order-status rows were returned for ${scope}.`;
      const total = data.channelRevenue.reduce((sum, row) => sum + row.value, 0);
      const lines = data.channelRevenue
        .map((row) => `${row.name}: ${row.value}${total ? ` (${Math.round((row.value / total) * 1000) / 10}%)` : ''}`)
        .join(', ');
      return `Order status report for ${scope}: ${lines}. Source: orders.status.`;
    }

    case 'shipping': {
      if (data.regionRevenue.length === 0) return `No shipping-region rows were returned for ${scope}.`;
      const lines = data.regionRevenue
        .slice(0, 5)
        .map((row) => `${row.region}: ${compactMoney.format(toNumber(row.revenue))}`)
        .join(', ');
      return `Shipping-region breakdown for ${scope}: ${lines}. Source: orders.ship_country_code.`;
    }

    default: {
      const topRegion = data.regionRevenue[0];
      const topProduct = data.topProducts[0];
      const regionSentence = topRegion
        ? `${topRegion.region} is the top region at ${compactMoney.format(toNumber(topRegion.revenue))}.`
        : 'No regional revenue rows were returned for this filter.';
      const productSentence = topProduct
        ? `${topProduct[0]} is the top product at ${topProduct[1]} revenue.`
        : 'No product revenue rows were returned for this filter.';
      return `Dashboard overview for ${scope}. Revenue is ${revenueKpi?.value ?? 'unknown'}, orders total ${ordersKpi?.value ?? 'unknown'}, and AOV is ${aovKpi?.value ?? 'unknown'}. ${regionSentence} ${productSentence} Source: orders, order_items, users.`;
    }
  }
}

async function writeNarrativeWithOpenAI(message, plan, data, deterministicAnswer, tablesUsed) {
  if (!process.env.OPENAI_API_KEY) return deterministicAnswer;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: openAiModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Write a concise BI assistant reply for a business analytics app. Use only the provided computed values. Never invent numbers, tables, columns, causes, trends, or recommendations that are not supported by the provided values. If you reference which data this came from, use only the table names listed in tablesUsed -- never a table name that is not in that list. If the values are insufficient, say what is available and what is not available. Do not mention SQL. Keep it plain, specific, and useful.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: message,
              plan,
              computedValues: {
                dateRange: data.dateRange,
                activeFilter: data.activeFilter,
                kpis: data.kpis.map((kpi) => ({
                  label: kpi.label,
                  value: kpi.value,
                  detail: kpi.detail,
                  context: kpi.context,
                })),
                topRegions: data.regionRevenue,
                statusMix: data.channelRevenue.map(({ name, value }) => ({ name, value })),
                topProducts: data.topProducts.slice(0, 3),
                tablesUsed,
                deterministicAnswer,
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) return deterministicAnswer;
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content?.trim() || deterministicAnswer;
  } catch (error) {
    console.error('OpenAI narrative failed, using deterministic answer:', error.message);
    return deterministicAnswer;
  }
}

async function handleChatMessage(message, pageState) {
  if (!message.trim()) {
    throw new Error('Message is empty.');
  }

  const plan = await planWithOpenAI(message, pageState);
  const { days, region, topic, intent } = plan;
  const data = await dashboardData({ windowDays: days, region });

  const deterministicAnswer =
    intent === 'answer' ? answerFromComputedData(message, plan, data) : reportFromComputedData(plan, data);
  const tablesUsed = tablesForTopic(topic);
  const narrative = await writeNarrativeWithOpenAI(message, plan, data, deterministicAnswer, tablesUsed);

  return {
    intent,
    title: topic === 'dashboard' ? 'Dashboard Update' : `${topic[0].toUpperCase()}${topic.slice(1)} View`,
    narrative,
    filters: { days, region },
    tablesUsed,
    data: intent === 'answer' ? null : data,
  };
}
