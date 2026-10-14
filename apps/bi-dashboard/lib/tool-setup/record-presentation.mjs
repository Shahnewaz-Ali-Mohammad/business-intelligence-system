export function recordNarrative(result, summary, query) {
  const population = summary?.population === undefined ? (result.hasMore ? undefined : result.rows.length) : Number(summary.population);
  const count = Number.isSafeInteger(population) && population >= 0 ? population : undefined;
  if (count === 0) return 'No records match the requested filters.';
  let text = count === undefined ? 'Matching records are available in the table below.' : `${count.toLocaleString()} matching ${count === 1 ? 'record' : 'records'}. Details are available in the table below.`;
  const plan = JSON.parse(query);
  if (plan.limit && !plan.sort?.length) text += ' This list uses the default record order.';
  return text;
}
