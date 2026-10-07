// One-off diagnostic: lists every table the SQLSERVER_* credentials in
// .env can actually SELECT from on the real production source server, by
// trying a real SELECT TOP 1 against each table information_schema
// reports -- not just what GRANT/permission metadata claims, since the
// two can genuinely differ depending on role membership.
import sql from 'mssql';
import 'dotenv/config';

const config = {
  server: process.env.SQLSERVER_HOST,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  options: { trustServerCertificate: true, encrypt: false },
};

const databases = [process.env.SQLSERVER_DB_BILLGENIX, process.env.SQLSERVER_DB_TICKETING].filter(Boolean);

for (const dbName of databases) {
  console.log(`\n=== Database: ${dbName} ===`);
  const pool = await sql.connect({ ...config, database: dbName });
  const { recordset: tables } = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);

  for (const { TABLE_SCHEMA: schema, TABLE_NAME: name } of tables) {
    const full = `[${schema}].[${name}]`;
    try {
      await pool.request().query(`SELECT TOP 1 * FROM ${full}`);
      console.log(`  OK      ${full}`);
    } catch (err) {
      console.log(`  DENIED  ${full}  -- ${err.message.split('\n')[0]}`);
    }
  }
  await pool.close();
}
