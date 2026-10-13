import type { DashboardData } from './metrics';

export type GraphSource = { query: Record<string, unknown>; maxRows?: number | null };
export type ReportGraphSpec = {
  version: 1; kind: 'bar' | 'line' | 'kpi' | 'histogram' | 'scatter' | 'density'; title: string;
  measure?: string; dimension?: string; time?: string; x?: string; y?: string;
  granularity: string; offset: number; pageSize?: number; search: string; direction: 'asc' | 'desc';
  filters: { member: string; operator: 'equals' | 'notSet'; values: string[] }[];
};
export type GraphField = { name: string; title: string; type: string; table?: string };
export type GraphOptions = {
  columns: GraphField[]; measures: GraphField[]; categories: GraphField[]; times: GraphField[]; numerics: GraphField[];
  kinds: ReportGraphSpec['kind'][]; defaultMeasure: string; defaultCategory?: string; defaultTime?: string;
  fixedGrouping?: boolean; fixedGranularity?: string;
};
export type GraphResult = {
  spec: ReportGraphSpec; options: GraphOptions; rows: { label: string; value: string; missing?: boolean; x?: number; y?: number }[];
  total: number; pageSize: number; population?: string; included?: string; generatedAt: string;
  mode: 'aggregate' | 'bins' | 'points'; bounds?: { xmin: string; xmax: string; ymin?: string; ymax?: string; bins: number };
};
export function reportGraphSource(data: DashboardData): GraphSource | null {
  const query = data.semanticQuery || data.chartQuery;
  return query ? { query, maxRows: data.semanticQueryMaxRows } : null;
}
