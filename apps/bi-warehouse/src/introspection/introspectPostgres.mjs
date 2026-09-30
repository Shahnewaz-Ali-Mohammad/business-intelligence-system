// ============================================================================
// Generic schema introspection for a customer's own Postgres database --
// the input to the AI semantic-model draft step (see
// src/semantic/draftSemanticModel.mjs). Reads information_schema/pg_catalog
// only; never touches or modifies the target database.
//
// This is intentionally separate from src/config/db.mjs's sourcePools --
// those are fixed to THIS project's own two known source databases
// (billGENIXDB, TicketingDB via mssql). This file connects to an
// arbitrary, caller-supplied Postgres connection string instead, since a
// newly onboarded workspace's source database is not known in advance.
// ============================================================================
import pg from 'pg';

const SAMPLE_ROW_LIMIT = 5;
// Counting distinct values on a huge table is expensive -- skip it past
// this row-count estimate rather than running an unbounded
// COUNT(DISTINCT ...) against a live production-sized table during
// onboarding.
const DISTINCT_COUNT_ROW_CEILING = 5_000_000;

export async function introspectPostgres(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000 });
  try {
    const tablesResult = await pool.query(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`
    );

    const tables = [];

    for (const { table_name: tableName } of tablesResult.rows) {
      const [columnsResult, pkResult, fkResult, rowCountResult] = await Promise.all([
        pool.query(
          `select column_name, data_type, is_nullable
             from information_schema.columns
            where table_schema = 'public' and table_name = $1
            order by ordinal_position`,
          [tableName]
        ),
        pool.query(
          `select kcu.column_name
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu
               on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
            where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'`,
          [tableName]
        ),
        pool.query(
          `select
             kcu.column_name,
             ccu.table_name as foreign_table_name,
             ccu.column_name as foreign_column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
           join information_schema.constraint_column_usage ccu
             on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
          where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'FOREIGN KEY'`,
          [tableName]
        ),
        pool.query(`select reltuples::bigint as estimate from pg_class where relname = $1`, [tableName]),
      ]);

      const primaryKeys = new Set(pkResult.rows.map((r) => r.column_name));
      const approxRowCount = rowCountResult.rows[0]?.estimate ?? null;

      const columns = [];
      for (const col of columnsResult.rows) {
        let distinctValueCount;
        if (approxRowCount === null || approxRowCount < DISTINCT_COUNT_ROW_CEILING) {
          try {
            const distinctResult = await pool.query(
              `select count(distinct "${col.column_name}") as count from "${tableName}"`
            );
            distinctValueCount = Number(distinctResult.rows[0]?.count ?? 0);
          } catch {
            // Some column types (e.g. json) don't support DISTINCT -- skip
            // silently, the AI draft step treats a missing count as
            // "unknown" rather than failing the whole introspection.
            distinctValueCount = undefined;
          }
        }
        columns.push({
          name: col.column_name,
          dataType: col.data_type,
          isNullable: col.is_nullable === 'YES',
          isPrimaryKey: primaryKeys.has(col.column_name),
          distinctValueCount,
        });
      }

      const foreignKeys = fkResult.rows.map((r) => ({
        column: r.column_name,
        referencesTable: r.foreign_table_name,
        referencesColumn: r.foreign_column_name,
      }));

      let sampleRows = [];
      try {
        const sampleResult = await pool.query(`select * from "${tableName}" limit ${SAMPLE_ROW_LIMIT}`);
        sampleRows = sampleResult.rows;
      } catch {
        sampleRows = [];
      }

      tables.push({ name: tableName, columns, foreignKeys, sampleRows, approxRowCount });
    }

    return { dialect: 'postgres', tables };
  } finally {
    await pool.end();
  }
}
