// A real MCP (Model Context Protocol) server for this dashboard's semantic
// layer. This is the "single source of truth for metrics" boundary called
// for in the project spec: the LLM never sees or writes raw SQL -- it only
// ever calls the typed `query_semantic_layer` tool below, which is backed by
// the same read-only dashboardData() query path used by the REST API
// (scripts/lib/dashboard-data.mjs), enforced read-only at the DB session
// level. A Resource is also exposed so an MCP-aware client can discover the
// semantic catalog (which tables/columns back which metric) on demand
// instead of that schema being baked into every prompt.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dashboardData, ALLOWED_TOPICS, TOPIC_TABLES } from '../lib/dashboard-data.mjs';

const SEMANTIC_CATALOG = `# BI Semantic Catalog (read-only)

This describes the ONLY tables this system can read from -- ecommerce, via a
read-only MySQL user. No table outside this list exists to the model.

## orders
Revenue, order volume, region, and status. Columns used: ordered_at,
grand_total, ship_country_code, status.
Backs topics: revenue, orders, regions, status, shipping.

## users
Customer accounts. Columns used: is_active, and a display-name column
detected at runtime (full_name/name/display_name/customer_name/username).
Backs topics: customers. The "customers by order count" ranking supports a
genuine most/least query direction -- use customerSort: "least" to get the
real bottom-N customers by order count, never derive "lowest" by reversing
a "most" result, since those are two different sets of rows.

## order_items
Line items per order (product, revenue, units). Backs topics: products.
Note: this table has no reliable date column, so product metrics are
all-time, not scoped to a day window.

## order_status_history
Status change log per order (changed_at, status). Backs topics: status.
`;

function summarizeForTool(data) {
  return {
    dateRange: data.dateRange,
    activeFilter: data.activeFilter,
    kpis: data.kpis.map((kpi) => ({ label: kpi.label, value: kpi.value, detail: kpi.detail })),
    regionRevenue: data.regionRevenue,
    statusMix: data.channelRevenue.map(({ name, value }) => ({ status: name, value })),
    topProducts: data.topProducts.slice(0, 10).map((row) => ({
      product: row[0],
      revenue: row[1],
      share: row[2],
      units: row[3],
      aov: row[4],
    })),
    customerMix: data.customerMix,
    repeatCustomers: data.repeatCustomers,
    topCustomersByOrders: data.topCustomersByOrders,
  };
}

export function createBiMcpServer() {
  const server = new McpServer({
    name: 'bi-semantic-layer',
    version: '1.0.0',
  });

  server.registerResource(
    'semantic-catalog',
    'schema://ecommerce/catalog',
    {
      title: 'BI Semantic Catalog',
      description: 'Which real tables/columns back each metric topic in this read-only ecommerce database.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{ uri: 'schema://ecommerce/catalog', mimeType: 'text/markdown', text: SEMANTIC_CATALOG }],
    }),
  );

  server.registerTool(
    'query_semantic_layer',
    {
      title: 'Query semantic layer',
      description:
        'The single source of truth for this business\'s metrics. Fetches real, live revenue/order/customer/product/region/status data from the read-only ecommerce database for a given trailing day window and optional region filter. Never returns SQL; only computed, grounded values. Always call this before answering any question about revenue, orders, customers, products, regions, or status.',
      inputSchema: {
        days: z.number().int().min(1).max(365).describe('Trailing day window to analyze, e.g. 7, 30, 90, 365.'),
        region: z
          .string()
          .nullable()
          .describe('Region/country code to filter to (e.g. "US"), or null for all regions.'),
        customerSort: z
          .enum(['most', 'least'])
          .nullable()
          .describe(
            'Ranking direction for the customers-by-order-count breakdown. "most" (default) for top customers by orders, "least" for the real bottom customers by orders -- these run genuinely different queries, so always set "least" when the user asks for the lowest/fewest/bottom customers by orders. Null/omit defaults to "most".',
          ),
      },
    },
    async ({ days, region, customerSort }) => {
      const data = await dashboardData({
        windowDays: days,
        region: region || null,
        customerSort: customerSort || 'most',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(summarizeForTool(data)) }],
        structuredContent: summarizeForTool(data),
        _fullData: data,
      };
    },
  );

  return server;
}

export { ALLOWED_TOPICS, TOPIC_TABLES };
