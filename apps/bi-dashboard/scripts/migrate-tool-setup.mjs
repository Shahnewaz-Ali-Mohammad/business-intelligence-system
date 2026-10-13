import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";

const database = process.env.DB_APP_NAME || "bi_app";
if (
  /^(ticketingdb|billgenixdb|postgres|mysql|master|model|msdb|tempdb)$/i.test(
    database,
  ) ||
  database === process.env.WAREHOUSE_PG_DATABASE
)
  throw new Error("Refusing to migrate an analytical or system database.");
const connection = await mysql.createConnection({
  host: process.env.DB_APP_HOST || "localhost",
  port: Number(process.env.DB_APP_PORT || 3306),
  user: process.env.DB_APP_USER || "bi_app_user",
  password: process.env.DB_APP_PASSWORD || "",
  database,
  multipleStatements: true,
});
try {
  const sql = await readFile(
    new URL("../database/tool-setup-migration.sql", import.meta.url),
    "utf8",
  );
  await connection.query(sql);
  console.log(
    "Tool setup application tables are ready. No source database was modified.",
  );
} finally {
  await connection.end();
}
