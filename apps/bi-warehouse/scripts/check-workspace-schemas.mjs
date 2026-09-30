// One-time diagnostic: lists every workspace_* schema in the warehouse with
// its table count and most recent dlt load timestamp, so we can tell a
// complete synced schema apart from a stale partial one left behind by a
// failed sync attempt, before dropping anything.
import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  host: process.env.WAREHOUSE_PG_HOST || 'localhost',
  port: Number(process.env.WAREHOUSE_PG_PORT || 5432),
  database: process.env.WAREHOUSE_PG_DATABASE,
  user: process.env.WAREHOUSE_PG_USER,
  password: process.env.WAREHOUSE_PG_PASSWORD,
});

const { rows: schemas } = await pool.query(
  "select schema_name from information_schema.schemata where schema_name like 'workspace_%' order by schema_name"
);

for (const { schema_name: s } of schemas) {
  const { rows: tableRows } = await pool.query(
    `select count(*)::int as n from information_schema.tables where table_schema = $1`,
    [s]
  );
  let lastLoad = 'n/a';
  try {
    const { rows } = await pool.query(`select max(inserted_at) as t from "${s}"."_dlt_loads"`);
    lastLoad = rows[0].t;
  } catch {
    lastLoad = 'no _dlt_loads table (never finished a sync)';
  }
  console.log(`${s}  |  tables: ${tableRows[0].n}  |  last successful load: ${lastLoad}`);
}

await pool.end();
