// Shared Cube result -> table formatting (chat agent + paged report API).

export function prettifyCubeFieldName(key) {
  // Drop the "CubeName." prefix (e.g. "IspBilling.total_billed" -> "total_billed"),
  // keeping the SHORT field name a column header reads naturally. A field
  // with no dot (shouldn't normally happen with Cube, but don't crash if
  // it does) is used as-is.
  const field = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  return field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function coerceCubeValue(value, member = '') {
  if (/(?:_id|_sk|_snid)$/.test(member)) return value;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return value;
}

export function buildSemanticQueryTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { headers: ['No data'], rows: [] };
  }
  const keys = Object.keys(rows[0]);
  return {
    headers: keys.map(prettifyCubeFieldName),
    rows: rows.map((row) => keys.map((k) => coerceCubeValue(row[k], k))),
  };
}
