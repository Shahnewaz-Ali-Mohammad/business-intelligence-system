import { CUBE_CATALOG } from '../../../bi-warehouse/src/semantic/cubeCatalog.mjs';
import { querySemanticLayer, loadCubeQuery } from '../../../bi-warehouse/src/services/cubeQueryService.mjs';
import { collectReportSummary } from '../../../bi-warehouse/src/semantic/reportSummary.mjs';
import { getWarehousePool } from '../../../bi-warehouse/src/config/db.mjs';
import { writeAnalyticalInsight } from './analytical-insight.mjs';
import { chartQueryForTool } from '../../../bi-warehouse/src/semantic/chartQuery.mjs';

export function recordListSummaryQuery(tool, args = {}) {
  if (!['get_ticket_list', 'get_customer_list'].includes(tool)) throw new Error('Unsupported record list.');
  const scoped = chartQueryForTool(tool, args);
  const root = scoped.measures[0].split('.')[0];
  return { ...scoped, measures: [], dimensions: CUBE_CATALOG.find((c) => c.name === root).dimensions.filter((d) => !/source_synced_at$/.test(d.name)).map((d) => d.name), ...(args.limit ? { limit: args.limit } : {}), timeDimensions: scoped.timeDimensions.map((t) => ({ dimension: t.dimension, ...(args.dateFrom || args.dateTo ? { dateRange: [args.dateFrom || '1900-01-01', args.dateTo || '9999-12-31'] } : {}) })) };
}

const label = (member) => member.split('.').at(-1).replaceAll('_', ' ');
const value = (member, number) => {
  if (number == null || !Number.isFinite(Number(number))) return 'unavailable';
  const formatted = Number(number).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return /billed|collected|refunded|adjusted|outstanding|transaction_amount/.test(member) ? `BDT ${formatted}` : formatted;
};

export async function describeQuery(query, page, title, load = querySemanticLayer, question = title) {
  const root = (query.measures?.[0] || query.dimensions?.[0] || query.timeDimensions?.[0]?.dimension)?.split('.')[0];
  const cube = CUBE_CATALOG.find((c) => c.name === root);
  const reportTitle = title?.trim() && title !== 'Query Results' ? title.trim() : `${root?.replace(/^Isp/, '') || 'Data'} Report`;
  if (!page.total) return { title: reportTitle, narrative: 'No records match the requested filters.' };
  if (load === querySemanticLayer) {
    try {
      const summary = await collectReportSummary(CUBE_CATALOG, query, (q) => loadCubeQuery(q, 'sql'), async (statement) => {
        const client = await getWarehousePool().connect();
        try {
          await client.query('BEGIN READ ONLY');
          await client.query("SET LOCAL statement_timeout = '20000ms'");
          const result = (await client.query(statement)).rows[0].result;
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      });
      const records = !query.measures?.length && page.total <= 5 ? page.rows : undefined;
      const insight = await writeAnalyticalInsight({ question, summary, records, currency: 'BDT' });
      return { title: reportTitle, narrative: `${page.total.toLocaleString()} matching ${query.measures?.length ? 'result groups' : 'records'}. ${insight}` };
    } catch (error) {
      console.error('[insight] Analytical statistics unavailable:', error.message);
    }
  }
  const parts = [`${page.total.toLocaleString()} matching ${query.measures?.length ? 'result groups' : 'records'}.`];
  if (load === querySemanticLayer) parts.push('Detailed averages, medians, and ranges are unavailable for this query; the following is a limited summary.');
  const base = { filters: query.filters ?? [], timeDimensions: (query.timeDimensions ?? []).map((t) => ({ dimension: t.dimension, ...(t.dateRange ? { dateRange: t.dateRange } : {}) })) };
  // Removing groups changes HAVING semantics; do not present a regrouped total as the same population.
  const measureMembers = new Set(CUBE_CATALOG.flatMap((c) => c.measures.map((m) => m.name)));
  const containsMeasureFilter = (filters) => filters.some((f) => measureMembers.has(f.member) || containsMeasureFilter(f.and ?? f.or ?? []));
  const hasMeasureFilter = containsMeasureFilter(base.filters);
  if (!hasMeasureFilter) {
    try {
      const measures = query.measures?.length ? query.measures : [cube?.measures.find((m) => m.type === 'count')?.name].filter(Boolean);
      if (measures.length) {
        const totals = await load({ ...base, measures });
        const row = totals[0];
        if (row) parts.push(`Across the full matching dataset: ${measures.map((m) => `${label(m)} is ${value(m, row[m])}`).join('; ')}.`);
        const category = query.measures?.length
          ? query.dimensions?.[0]
          : root === 'IspCustomer' ? 'IspStatus.status_name'
            : root === 'IspTicket' ? 'IspTicketType.ticket_type_name'
              : cube?.dimensions.find((d) => /\.(status|status_id|connection_type|ticket_type_id|package_id)$/.test(d.name))?.name;
        if (category) {
          const leaders = await load({ ...base, measures: [measures[0]], dimensions: [category], order: { [measures[0]]: 'desc', [category]: 'asc' }, limit: 1 });
          const leader = leaders[0];
          if (leader) parts.push(`The highest ${label(measures[0])} by ${label(category)} is ${leader[category] ?? 'Unassigned'}, at ${value(measures[0], leader[measures[0]])}.`);
        } else {
          const period = query.timeDimensions?.find((t) => t.granularity);
          if (period) {
            const peaks = await load({ ...base, measures: [measures[0]], timeDimensions: query.timeDimensions, order: { [measures[0]]: 'desc', [period.dimension]: 'asc' }, limit: 1 });
            const peak = peaks[0];
            if (peak) parts.push(`The peak ${period.granularity} is ${peak[`${period.dimension}.${period.granularity}`] ?? peak[period.dimension] ?? 'unavailable'}, with ${label(measures[0])} of ${value(measures[0], peak[measures[0]])}.`);
          }
        }
        if (query.limit) parts.push(`The table is limited to the requested ${query.limit} results; the summary above covers all matching records before that ranking limit.`);
      }
    } catch (error) {
      console.error('[insight] Full-dataset summary unavailable:', error.message);
      parts.push('The full-dataset analytical summary could not be calculated; the table results remain available.');
    }
  } else {
    parts.push('These groups satisfy the requested aggregate thresholds; totals across a different grouping are not substituted.');
    try {
      const metric = query.measures[0];
      const leaders = await load({ ...query, order: { [metric]: 'desc' }, limit: 1 });
      const row = leaders[0];
      if (row) parts.push(`The highest matching ${label(metric)} is ${value(metric, row[metric])}${query.dimensions?.length ? ` for ${query.dimensions.map((d) => `${label(d)} ${row[d] ?? 'Unassigned'}`).join(', ')}` : ''}.`);
    } catch (error) {
      console.error('[insight] Threshold leader unavailable:', error.message);
    }
  }
  if (!query.measures?.length && page.total <= 5) {
    parts.push(...page.rows.map((row) => Object.entries(row).map(([key, v]) => `${label(key)}: ${v ?? 'Unavailable'}`).join('; ')));
  }
  return { title: reportTitle, narrative: parts.join(' ') };
}
