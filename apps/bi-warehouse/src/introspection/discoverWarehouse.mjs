import pg from 'pg';
import crypto from 'node:crypto';
import { quote, sensitiveTable, safeColumns } from '../semantic/warehouseModel.mjs';

export function connectionConfig(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error('Enter a PostgreSQL connection URL.');
  const hosts = (process.env.WORKSPACE_ALLOWED_HOSTS || `localhost,127.0.0.1,${process.env.WAREHOUSE_PG_HOST || ''}`).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.includes(url.hostname.toLowerCase())) throw new Error('This warehouse host is not approved by the server administrator.');
  for (const key of url.searchParams.keys()) if (!['sslmode'].includes(key)) throw new Error('Unsupported connection URL option.');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['disable', 'require', 'verify-full'].includes(sslmode)) throw new Error('Unsupported SSL mode.');
  return { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ...(sslmode && sslmode !== 'disable' ? { ssl: { rejectUnauthorized: true } } : {}), options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10000, statement_timeout: 20000, application_name: 'bi_warehouse_discovery' };
}
export async function readWarehouse(connectionString, fn) {
  const client = new pg.Client(connectionConfig(connectionString));
  try { await client.connect(); await client.query('BEGIN READ ONLY'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await client.end(); }
}
export async function discoverWarehouse(connectionString, schemas = []) {
  if (!Array.isArray(schemas) || schemas.length > 10 || schemas.some((s) => typeof s !== 'string' || !s || s.length > 63)) throw new Error('Choose up to ten schemas.');
  return readWarehouse(connectionString, async (client) => {
    const available = (await client.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(oid,'USAGE') ORDER BY nspname`)).rows.map((r) => r.nspname);
    if (!schemas.length) return { schemas: available, tables: [], joins: [], candidates: [] };
    if (schemas.some((s) => !available.includes(s))) throw new Error('Selected schema is unavailable.');
    const result = await client.query(`SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid,c.reltuples::text AS estimate,
      a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS sql_type,t.typname AS udt,
      a.attnotnull AS not_null, a.attnum,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname,a.attnum`, [schemas]);
    const types = { int2: 'smallint', int4: 'integer', int8: 'bigint', numeric: 'numeric', float4: 'real', float8: 'double precision', varchar: 'character varying', bpchar: 'character', text: 'text', uuid: 'uuid', date: 'date', timestamp: 'timestamp without time zone', timestamptz: 'timestamp with time zone', bool: 'boolean' };
    const map = new Map();
    for (const r of result.rows) {
      const key = `${r.schema}.${r.name}`;
      if (!map.has(key)) map.set(key, { key, schema: r.schema, name: r.name, oid: r.oid, approxRowCount: Math.max(0, Number(r.estimate)), restricted: sensitiveTable(r.name), columns: [] });
      map.get(key).columns.push({ name: r.column_name, dataType: types[r.udt] ?? r.sql_type, isNullable: !r.not_null, isPrimaryKey: r.primary_key });
    }
    const tables = [...map.values()];
    if (tables.length > 500) throw new Error('Select fewer schemas; discovery supports up to 500 tables per connection.');
    const fks = await client.query(`SELECT con.conname AS id,ns.nspname||'.'||src.relname AS source,nt.nspname||'.'||dst.relname AS target,
      jsonb_agg(jsonb_build_object('from',sa.attname,'to',ta.attname) ORDER BY k.ord) AS columns
      FROM pg_constraint con JOIN pg_class src ON src.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=src.relnamespace
      JOIN pg_class dst ON dst.oid=con.confrelid JOIN pg_namespace nt ON nt.oid=dst.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(s,t,ord)
      JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attnum=k.s JOIN pg_attribute ta ON ta.attrelid=dst.oid AND ta.attnum=k.t
      WHERE con.contype='f' AND con.convalidated AND ns.nspname=ANY($1) GROUP BY con.oid,con.conname,ns.nspname,src.relname,nt.nspname,dst.relname`, [schemas]);
    const joins = fks.rows.map((r) => ({ id: `${r.source}:${r.id}`, from: r.source, to: r.target, columns: r.columns, evidence: 'database foreign key' }));
    // The raw mirror deliberately did not recreate FK constraints. Preserve
    // source declarations as review candidates, not as enforced PG evidence.
    const candidates = [];
    if (schemas.includes('raw_ticketing') && (await client.query("SELECT CASE WHEN to_regclass('raw_ticketing_meta.table_copies') IS NOT NULL THEN has_table_privilege(to_regclass('raw_ticketing_meta.table_copies'), 'SELECT') ELSE false END AS allowed")).rows[0].allowed) {
      const rows = (await client.query('SELECT destination_table,foreign_keys FROM raw_ticketing_meta.table_copies')).rows;
      for (const row of rows) {
        const grouped = new Map();
        for (const fk of row.foreign_keys) {
          const id = `raw_ticketing.${row.destination_table}:${fk.constraint_name}`;
          if (!grouped.has(id)) grouped.set(id, { id, from: `raw_ticketing.${row.destination_table}`, to: `raw_ticketing.${fk.referenced_table}`, columns: [], evidence: 'copied source declaration; requires review' });
          grouped.get(id).columns.push({ from: fk.column_name, to: fk.referenced_column });
        }
        candidates.push(...grouped.values());
      }
    }
    for (const from of tables.filter((t) => !t.restricted)) for (const to of tables.filter((t) => !t.restricted && t !== from)) {
      const pk = safeColumns(to).filter((c) => c.isPrimaryKey);
      if (pk.length !== 1 || !/(?:id|sk|snid)$/i.test(pk[0].name)) continue;
      const col = safeColumns(from).find((c) => c.name.toLowerCase() === pk[0].name.toLowerCase() && c.dataType === pk[0].dataType && !c.isPrimaryKey);
      if (!col || [...joins, ...candidates].some((j) => j.from === from.key && j.to === to.key)) continue;
      candidates.push({ id: `${from.key}:${col.name}->${to.key}`, from: from.key, to: to.key, columns: [{ from: col.name, to: pk[0].name }], evidence: 'matching column name and target primary key; requires review' });
    }
    joins.sort((a, b) => a.id.localeCompare(b.id)); candidates.sort((a, b) => a.id.localeCompare(b.id));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ tables: tables.map(({ key, columns }) => ({ key, columns })), joins, candidates })).digest('hex');
    return { schemas, availableSchemas: available, tables: tables.map((t) => ({ ...t, approvedColumnCount: safeColumns(t).length })), joins, candidates: candidates.filter((j) => map.has(j.from) && map.has(j.to)), fingerprint };
  });
}
export async function validateSelectedTables(connectionString, model) {
  return readWarehouse(connectionString, async (client) => {
    for (const cube of model.cubes) {
      const fields = cube.dimensions.filter((d) => d.meta?.column).map((d) => quote(d.meta.column));
      await client.query(`SELECT ${fields.join(',')} FROM ${cube.sql_table} LIMIT 0`);
    }
    return true;
  });
}
