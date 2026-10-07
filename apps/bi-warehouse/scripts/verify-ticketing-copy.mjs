import assert from 'node:assert/strict';
import { getSourcePool, getWarehousePool } from '../src/config/db.mjs';
import { pgIdentifier as pgId, sqlIdentifier as sqlId, sourceExpression } from '../src/etl/lib/rawCopy.mjs';

const pool = getWarehousePool();
let source;
try {
  source = await getSourcePool(process.env.SQLSERVER_DB_TICKETING || 'TicketingDB');
  const tables = await source.request().query("SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'");
  const checkpoints = await pool.query('SELECT * FROM raw_ticketing_meta.table_copies ORDER BY source_table');
  assert.equal(checkpoints.rows.length, tables.recordset.length, 'Not all source tables have completed copy checkpoints');
  let totalRows = 0n, totalColumns = 0;
  for (const table of tables.recordset) {
    const saved = checkpoints.rows.find((r) => r.source_schema === table.schema_name && r.source_table === table.table_name);
    assert.ok(saved, `Missing table: ${table.table_name}`);
    const destination = `${pgId('raw_ticketing')}.${pgId(saved.destination_table)}`;
    const rows = await pool.query(`SELECT count(*) AS n FROM ${destination}`);
    assert.equal(rows.rows[0].n, saved.row_count, `Count mismatch: ${table.table_name}`);
    const columns = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', ['raw_ticketing', saved.destination_table]);
    assert.deepEqual(columns.rows.map((c) => c.column_name), saved.columns.map((c) => c.column_name), `Column mismatch: ${table.table_name}`);
    totalRows += BigInt(saved.row_count);
    totalColumns += saved.columns.length;
  }
  console.log(JSON.stringify({ tables: checkpoints.rows.length, columns: totalColumns, rows: String(totalRows), allDestinationCountsAndColumnsVerified: true }));
  // Compare full sampled records without printing customer data or credentials.
  for (const name of ['Tk_TicketInfoMaster', 'CustomerMaster', 'TicketNotes', 'TicketHistory', 'Tk_TicketStatus', 'Tk_TicketType']) {
    const saved = checkpoints.rows.find((r) => r.source_table === name);
    assert.ok(saved);
    const keys = saved.primary_key_columns;
    if (!keys.length) { console.log(JSON.stringify({ table: name, sampleSkipped: 'No declared primary key for an exact record comparison' })); continue; }
    const records = await source.request().query(`SELECT TOP (5) ${saved.columns.map(sourceExpression).join(',')} FROM ${sqlId(saved.source_schema)}.${sqlId(name)} ORDER BY ${keys.map((k) => sqlId(k.column_name)).join(',')}`);
    for (const row of records.recordset) {
      const selections = saved.columns.map((c) => ['date', 'datetime', 'datetime2', 'smalldatetime', 'time', 'datetimeoffset', 'decimal', 'numeric', 'money', 'smallmoney', 'bigint'].includes(c.data_type)
        ? `${pgId(c.column_name)}::text AS ${pgId(c.column_name)}` : pgId(c.column_name));
      const actual = await pool.query(`SELECT ${selections.join(',')} FROM ${pgId('raw_ticketing')}.${pgId(saved.destination_table)} WHERE ${keys.map((k, i) => `${pgId(k.column_name)}=$${i + 1}`).join(' AND ')}`, keys.map((k) => row[k.column_name]));
      assert.equal(actual.rows.length, 1, `Missing source sample in ${name}`);
      for (const c of saved.columns) {
        const canonical = (value) => {
          if (value == null) return null;
          if (['datetime', 'datetime2', 'smalldatetime', 'time'].includes(c.data_type)) return String(value).replace('T', ' ').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
          return value;
        };
        assert.deepEqual(canonical(actual.rows[0][c.column_name]), canonical(row[c.column_name]), `Value mismatch in ${name}.${c.column_name}`);
      }
    }
    console.log(JSON.stringify({ table: name, fullRecordsCompared: records.recordset.length, columnsPerRecord: saved.columns.length, passed: true }));
  }
} finally {
  if (source) await source.close();
  await pool.end();
}
