/** @param {{ category?: string, metric?: string|null, aggregation?: string, signal?: AbortSignal }} options */
export async function aggregateProcedureGraph(rows, columns, options = {}) {
  const { category, metric = null, aggregation = 'sum', signal } = options;
  if (!columns.includes(category) || (metric !== null && !columns.includes(metric)) || !['sum', 'avg', 'min', 'max', 'count'].includes(aggregation)) throw new Error('Choose valid report columns and a supported calculation.');
  const groups = new Map(); let population = 0;
  for await (const row of rows) {
    if (signal?.aborted) throw new Error('Graph cancelled.');
    population++;
    const raw = row[category]; const key = JSON.stringify([typeof raw, raw ?? null]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 100000) throw new Error('Too many distinct graph categories. Choose a less detailed grouping column.');
      group = { label: raw == null ? '(NULL)' : raw === '' ? '(empty)' : String(raw), records: 0, count: 0, sum: 0, min: Infinity, max: -Infinity };
      groups.set(key, group);
    }
    group.records++;
    const cell = metric === null ? 1 : row[metric];
    const value = cell == null || cell === '' || typeof cell === 'boolean' ? NaN : Number(cell);
    if (Number.isFinite(value)) { group.count++; group.sum += value; group.min = Math.min(group.min, value); group.max = Math.max(group.max, value); }
  }
  const result = [...groups.values()].map(group => ({ category: group.label, value: aggregation === 'count' || metric === null ? group.records : !group.count ? null : aggregation === 'avg' ? group.sum / group.count : aggregation === 'min' ? group.min : aggregation === 'max' ? group.max : group.sum }));
  result.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.category.localeCompare(b.category));
  return { rows: result.slice(0, 100), category: 'category', metric: 'value', hasMore: result.length > 100, scope: `All ${population.toLocaleString('en-US')} stored rows · ${Math.min(100, result.length)} of ${result.length.toLocaleString('en-US')} groups`, population };
}
