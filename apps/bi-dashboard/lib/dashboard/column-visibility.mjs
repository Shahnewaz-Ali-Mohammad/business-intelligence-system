export function visibleColumnIndexes(headers, hidden = []) {
  const excluded = new Set(Array.isArray(hidden) ? hidden : []);
  return headers.flatMap((header, index) => excluded.has(header) ? [] : [index]);
}

export function projectColumns(headers, rows, hidden = []) {
  const indexes = visibleColumnIndexes(headers, hidden);
  return { headers: indexes.map(i => headers[i]), rows: rows.map(row => indexes.map(i => row[i])) };
}

export function exportHiddenColumns(searchParams) {
  try {
    const hidden = JSON.parse(searchParams.get('hiddenColumns') || '[]');
    return Array.isArray(hidden) ? hidden.filter(v => typeof v === 'string').slice(0, 2000) : [];
  } catch { return []; }
}
