import { compileTool } from './model.mjs';

export function toolContext(tool, catalog) {
  const definition = tool.definition;
  const fields = new Set(definition.capabilities?.fields || [...definition.columns, ...definition.groupBy, ...definition.metrics.map((m) => m.field).filter(Boolean), ...definition.filters.map((f) => f.field)]);
  return { id: tool.id, name: definition.name, description: definition.description, mode: definition.mode,
    base: definition.base, columns: definition.columns, metrics: definition.metrics, filters: definition.filters,
    fields: catalog.objects.flatMap((o) => o.columns.filter((c) => fields.has(`${o.id}:${c.name}`)).map((c) => ({ id: `${o.id}:${c.name}`, type: c.dataType, table: o.name }))),
    relationships: catalog.relationships.filter((j) => (definition.capabilities?.joins || definition.joins).includes(j.id)) };
}
export function requiresDetailedReport(message) {
  return /\b(report|details|list|records|directory)\b/i.test(message) && !/\b(count|how many|total|summary|summari[sz]e|average|sum|breakdown|by|trend|statistics|top|lowest|highest)\b/i.test(message);
}
/**
 * @template {{definition: any}} T
 * @param {string} message
 * @param {T[]} tools
 * @returns {T[]}
 */
export function candidateTools(message, tools) {
  if (requiresDetailedReport(message)) return tools.filter((t) => t.definition.mode === 'rows');
  if (/\b(how many|count|total|average|sum|summary|summari[sz]e|breakdown|statistics)\b/i.test(message)) {
    const global = !/\b(by|per|each|breakdown)\b/i.test(message);
    return tools.filter((t) => t.definition.mode === 'aggregate' && (!global || t.definition.capabilities || !t.definition.groupBy.length));
  }
  return tools;
}
/** @param {{message: string, definition: any, catalog: any, dialect: string, query: string, requiredFields?: string[]}} input */
export function checkReportPlan({ message, definition, catalog, dialect, query, requiredFields = [] }) {
  const plan = JSON.parse(query);
  const compiled = compileTool(definition, catalog, dialect, { query });
  const columns = definition.capabilities ? (plan.columns ?? definition.columns) : definition.columns;
  const groups = definition.capabilities ? (plan.groupBy ?? definition.groupBy) : definition.groupBy;
  const metrics = definition.capabilities ? (plan.metrics ?? definition.metrics) : definition.metrics;
  if (requiresDetailedReport(message) && definition.mode !== 'rows') {
    throw new Error('A detailed report requires record fields; a count alone does not fulfill this request.');
  }
  const used = new Set([...columns, ...groups, ...metrics.map((m) => m.field).filter(Boolean)]);
  if (requiredFields.some((field) => !used.has(field))) throw new Error('The report plan omits requested fields.');
  return compiled;
}
