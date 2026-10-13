import { compileTool } from './model.mjs';

export function recordGraphPlan(tool, catalog, dialect, query, groupBy) {
  const original = compileTool(tool, catalog, dialect, { query });
  if (tool.mode !== 'rows' || !original.outputFields.includes(groupBy))
    throw new Error('Graph grouping must be a returned record column.');
  const plan = JSON.parse(query);
  return JSON.stringify({
    groupBy: [groupBy],
    metrics: [{ field: null, operation: 'count', alias: 'record_count' }],
    joins: original.joinIds || plan.joins || [],
    ...(plan.where?{where:plan.where}:{}),
    filters: plan.filters || [],
    values: plan.values || {},
  });
}
