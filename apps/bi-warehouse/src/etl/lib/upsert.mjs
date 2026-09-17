// ============================================================================
// Generic upsert helper for landing rows into a warehouse table.
//
// Every table sync (src/etl/tables/*.js) pulls rows from SQL Server, maps
// them to the warehouse's column names, then calls this to write them —
// insert if new, update if the natural key already exists. Never deletes:
// these are business-event tables, history shouldn't disappear just
// because a sync run behaves oddly.
// ============================================================================

import { getWarehousePool } from '../../config/db.mjs';

/**
 * @param {string} table - warehouse table name, e.g. 'fact_billing'
 * @param {string[]} conflictColumns - columns forming the natural key, e.g. ['source_snid']
 * @param {object[]} rows - array of row objects; each key becomes a column
 */
export async function upsertRows(table, conflictColumns, rows) {
  if (!rows.length) return 0;

  const pool = getWarehousePool();
  const columns = Object.keys(rows[0]);
  const updateSet = columns
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  // Batch in chunks to keep parameter counts sane for large tables like
  // BillingMaster (12M+ rows) — never send the whole table in one INSERT.
  const CHUNK_SIZE = 1000;
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values = [];
    const placeholders = chunk.map((row, rowIdx) => {
      const rowPlaceholders = columns.map((col) => {
        values.push(row[col]);
        return `$${values.length}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });

    const query = `
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (${conflictColumns.join(', ')})
      DO UPDATE SET ${updateSet}
    `;

    await pool.query(query, values);
    written += chunk.length;
  }

  return written;
}
