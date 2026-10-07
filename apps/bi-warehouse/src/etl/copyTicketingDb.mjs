import sql from 'mssql';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { sourceConfig, getWarehousePool } from '../config/db.mjs';
import { pgIdentifier as pgId, sqlIdentifier as sqlId, postgresType, sourceExpression, rowEncoder } from './lib/rawCopy.mjs';

const targetSchema = 'raw_ticketing';
const stageSchema = 'raw_ticketing_staging';
const metaSchema = 'raw_ticketing_meta';
const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
const hash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

async function inspectSource(source) {
  const { recordsets } = await source.request().query(`
    SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS table_name
    FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA,TABLE_NAME;
    SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS table_name,COLUMN_NAME AS column_name,
      DATA_TYPE AS data_type,ORDINAL_POSITION AS ordinal_position,IS_NULLABLE AS is_nullable,
      NUMERIC_PRECISION AS numeric_precision,NUMERIC_SCALE AS numeric_scale,
      CHARACTER_MAXIMUM_LENGTH AS maximum_length,DATETIME_PRECISION AS datetime_precision
    FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION;
    SELECT SCHEMA_NAME(t.schema_id) AS schema_name,t.name AS table_name,c.name AS column_name,
      i.name AS key_name,ic.key_ordinal
    FROM sys.tables t JOIN sys.indexes i ON i.object_id=t.object_id AND i.is_primary_key=1
      JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
      JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=ic.column_id
    ORDER BY t.name,ic.key_ordinal;
    SELECT fk.name AS constraint_name,SCHEMA_NAME(t.schema_id) AS schema_name,t.name AS table_name,
      c.name AS column_name,SCHEMA_NAME(rt.schema_id) AS referenced_schema,
      rt.name AS referenced_table,rc.name AS referenced_column,fkc.constraint_column_id
    FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
      JOIN sys.tables t ON t.object_id=fkc.parent_object_id
      JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id
      JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id;
    SELECT s.name AS schema_name,v.name AS view_name,m.definition
    FROM sys.views v JOIN sys.schemas s ON s.schema_id=v.schema_id
      LEFT JOIN sys.sql_modules m ON m.object_id=v.object_id;
  `);
  const [tables, columns, keys, relationships, views] = recordsets;
  for (const table of tables) {
    table.destination = table.schema_name === 'dbo' ? table.table_name : `${table.schema_name}__${table.table_name}`;
    if (Buffer.byteLength(table.destination) > 63) throw new Error('A source table name exceeds the PostgreSQL identifier limit.');
    table.columns = columns.filter((c) => c.schema_name === table.schema_name && c.table_name === table.table_name);
    for (const c of table.columns) {
      if (Buffer.byteLength(c.column_name) > 63) throw new Error('A source column name exceeds the PostgreSQL identifier limit.');
      postgresType(c);
      if (Number(c.datetime_precision) > 6) throw new Error(`Sub-microsecond date precision requires an explicit preservation strategy for ${table.table_name}.${c.column_name}.`);
    }
    table.keys = keys.filter((k) => k.schema_name === table.schema_name && k.table_name === table.table_name);
    table.relationships = relationships.filter((k) => k.schema_name === table.schema_name && k.table_name === table.table_name);
    table.fingerprint = hash(table.columns);
    await source.request().query(`SELECT TOP (0) * FROM ${sqlId(table.schema_name)}.${sqlId(table.table_name)}`);
  }
  if (new Set(tables.map((t) => t.destination)).size !== tables.length) throw new Error('Source names collide in the destination schema.');
  return { tables, views };
}

async function ensureDestination(pool, database, views) {
  for (const schema of [targetSchema, stageSchema, metaSchema]) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgId(schema)}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${pgId(metaSchema)}.table_copies (
    source_schema text NOT NULL,source_table text NOT NULL,destination_table text NOT NULL,
    source_database text NOT NULL,fingerprint text NOT NULL,columns jsonb NOT NULL,
    primary_key_columns jsonb NOT NULL,foreign_keys jsonb NOT NULL,
    row_count bigint NOT NULL,source_rows_before bigint NOT NULL,source_rows_after bigint NOT NULL,
    started_at timestamptz NOT NULL,completed_at timestamptz NOT NULL,
    PRIMARY KEY(source_schema,source_table))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${pgId(metaSchema)}.source_views (
    source_schema text NOT NULL,view_name text NOT NULL,sql_server_definition text,
    captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_schema,view_name))`);
  for (const v of views) await pool.query(`INSERT INTO ${pgId(metaSchema)}.source_views(source_schema,view_name,sql_server_definition)
    VALUES($1,$2,$3) ON CONFLICT(source_schema,view_name) DO UPDATE SET sql_server_definition=excluded.sql_server_definition,captured_at=now()`, [v.schema_name, v.view_name, v.definition]);
  const prior = await pool.query(`SELECT DISTINCT source_database FROM ${pgId(metaSchema)}.table_copies`);
  if (prior.rows.some((r) => r.source_database !== database)) throw new Error('The raw destination already belongs to a different source database.');
}

async function sourceCount(source, table) {
  const result = await source.request().query(`SELECT COUNT_BIG(*) AS n FROM ${sqlId(table.schema_name)}.${sqlId(table.table_name)}`);
  return String(result.recordset[0].n);
}

async function copyTable(source, pool, table, database, force = false) {
  const sourceRowsBefore = await sourceCount(source, table);
  const previous = await pool.query(`SELECT * FROM ${pgId(metaSchema)}.table_copies WHERE source_schema=$1 AND source_table=$2`, [table.schema_name, table.table_name]);
  const destination = `${pgId(targetSchema)}.${pgId(table.destination)}`;
  if (!force && previous.rows[0]?.fingerprint === table.fingerprint) {
    const exists = await pool.query('SELECT to_regclass($1) AS name', [destination]);
    if (exists.rows[0].name) {
      const actual = await pool.query(`SELECT count(*) AS n FROM ${destination}`);
      if (actual.rows[0].n === previous.rows[0].row_count) {
        log({ event: 'already_copied', table: table.table_name, rows: actual.rows[0].n, sourceRowsNow: sourceRowsBefore, note: 'Resume retains the completed copy; use --refresh to recopy changed values.' });
        return BigInt(actual.rows[0].n);
      }
    }
  }
  const started = new Date();
  const stageName = `copy_${hash([table.schema_name, table.table_name]).slice(0, 24)}`;
  const stage = `${pgId(stageSchema)}.${pgId(stageName)}`;
  const client = await pool.connect();
  let request, readable, ingest;
  let copied = 0n;
  let lastProgress = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE ${stage} (${table.columns.map((c) => `${pgId(c.column_name)} ${postgresType(c)}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`).join(',')})`);
    request = source.request();
    readable = request.toReadableStream({ highWaterMark: 32 });
    ingest = client.query(copyFrom(`COPY ${stage} (${table.columns.map((c) => pgId(c.column_name)).join(',')}) FROM STDIN WITH (FORMAT text)`));
    const copying = pipeline(readable, rowEncoder(table.columns, () => {
      copied++;
      if (Date.now() - lastProgress > 10000) {
        log({ event: 'copy_progress', table: table.table_name, copied: String(copied), sourceRowsBefore });
        lastProgress = Date.now();
      }
    }), ingest);
    const extracting = request.query(`SELECT ${table.columns.map(sourceExpression).join(',')} FROM ${sqlId(table.schema_name)}.${sqlId(table.table_name)}`).catch((error) => { readable.destroy(error); throw error; });
    await Promise.all([copying, extracting]);
    const count = await client.query(`SELECT count(*) AS n FROM ${stage}`);
    if (BigInt(count.rows[0].n) !== copied || BigInt(ingest.rowCount) !== copied) throw new Error('Extracted and destination row counts differ. The table has not been published.');
    if (table.keys.length) await client.query(`ALTER TABLE ${stage} ADD PRIMARY KEY (${table.keys.map((k) => pgId(k.column_name)).join(',')})`);
    const sourceRowsAfter = await sourceCount(source, table);
    // Publishing and its checkpoint are atomic; never expose half a table.
    const exists = await client.query('SELECT to_regclass($1) AS name', [destination]);
    if (exists.rows[0].name) {
      if (!previous.rows.length) throw new Error('Destination table exists without a copy checkpoint; refusing to overwrite it.');
      await client.query(`DROP TABLE ${destination}`);
    }
    await client.query(`ALTER TABLE ${stage} SET SCHEMA ${pgId(targetSchema)}`);
    await client.query(`ALTER TABLE ${pgId(targetSchema)}.${pgId(stageName)} RENAME TO ${pgId(table.destination)}`);
    await client.query(`INSERT INTO ${pgId(metaSchema)}.table_copies
      (source_schema,source_table,destination_table,source_database,fingerprint,columns,primary_key_columns,foreign_keys,row_count,source_rows_before,source_rows_after,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) ON CONFLICT(source_schema,source_table) DO UPDATE SET
      destination_table=excluded.destination_table,source_database=excluded.source_database,fingerprint=excluded.fingerprint,
      columns=excluded.columns,primary_key_columns=excluded.primary_key_columns,foreign_keys=excluded.foreign_keys,
      row_count=excluded.row_count,source_rows_before=excluded.source_rows_before,source_rows_after=excluded.source_rows_after,
      started_at=excluded.started_at,completed_at=excluded.completed_at`,
    [table.schema_name, table.table_name, table.destination, database, table.fingerprint, JSON.stringify(table.columns), JSON.stringify(table.keys), JSON.stringify(table.relationships), String(copied), sourceRowsBefore, sourceRowsAfter, started]);
    await client.query('COMMIT');
    await client.query(`ANALYZE ${destination}`);
    log({ event: 'table_copied', table: table.table_name, columns: table.columns.length, rows: String(copied), sourceRowsBefore, sourceRowsAfter, sourceChangedDuringRead: sourceRowsBefore !== sourceRowsAfter || sourceRowsAfter !== String(copied), seconds: Math.round((Date.now() - started) / 1000) });
    return copied;
  } catch (error) {
    if (request) request.cancel();
    if (readable && !readable.destroyed) readable.destroy();
    if (ingest && !ingest.destroyed) ingest.destroy();
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function main() {
  const database = process.env.SQLSERVER_DB_TICKETING || 'TicketingDB';
  if (database !== 'TicketingDB') throw new Error('This copy command is restricted to TicketingDB.');
  const pool = getWarehousePool();
  const lock = await pool.connect();
  let source;
  try {
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext('ticketing_full_raw_copy')) AS acquired");
    if (!result.rows[0].acquired) throw new Error('A TicketingDB copy is already running.');
    source = await new sql.ConnectionPool({ ...sourceConfig, database, requestTimeout: 0, pool: { max: 2, min: 0, idleTimeoutMillis: 30000 } }).connect();
    log({ event: 'inspect_source', database });
    const { tables, views } = await inspectSource(source);
    await ensureDestination(pool, database, views);
    const subset = process.argv.find((a) => a.startsWith('--tables='))?.slice(9).split(',');
    if (subset?.some((name) => !tables.some((t) => t.table_name === name))) throw new Error('Unknown requested table.');
    const selected = subset ? tables.filter((t) => subset.includes(t.table_name)) : tables;
    const force = process.argv.includes('--refresh');
    log({ event: 'copy_started', sourceTables: tables.length, selectedTables: selected.length, viewsCaptured: views.length, schema: targetSchema, snapshot: 'per-table live reads; source snapshot isolation is not enabled' });
    let completed = 0, total = 0n;
    const failures = [];
    for (const table of selected) {
      log({ event: 'table_start', table: table.table_name, completed, totalTables: selected.length });
      try { total += await copyTable(source, pool, table, database, force); completed++; }
      catch (error) { failures.push({ table: table.table_name, error: error.message }); log({ event: 'table_failed', table: table.table_name, error: error.message }); }
    }
    log({ event: 'copy_finished', completed, expectedTables: selected.length, totalRows: String(total), failures });
    if (failures.length) process.exitCode = 1;
  } finally {
    if (source) await source.close();
    await lock.query("SELECT pg_advisory_unlock(hashtext('ticketing_full_raw_copy'))").catch(() => {});
    lock.release();
    await pool.end();
  }
}
