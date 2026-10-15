import {namedKeyLinks} from './named-key-links.mjs';
import pg from "pg";
import mysql from "mysql2/promise";
import mssql from "mssql";
import {
  ConnectionSchema,
  compileTool,
  fingerprint,
  isProtectedColumn,
  numericType,
} from "./model.mjs";
import { summaryQuery } from "./result-summary.mjs";

export function validateConnection(input) {
  const config = ConnectionSchema.parse(input);
  const approved = (
    process.env.SOURCE_DATABASE_ALLOWED_HOSTS ||
    process.env.WORKSPACE_ALLOWED_HOSTS ||
    `localhost,127.0.0.1,${process.env.SQLSERVER_HOST || ""},${process.env.WAREHOUSE_PG_HOST || ""}`
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!approved.includes(config.host.toLowerCase()))
    throw new Error(
      "Host is not approved. Add it to SOURCE_DATABASE_ALLOWED_HOSTS on the application server.",
    );
  return config;
}
export async function withDatabase(input, fn) {
  const c = validateConnection(input);
  if (c.dialect === "postgres") {
    const client = new pg.Client({
      host: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: c.database,
      ssl: c.tls ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
      options: "-c default_transaction_read_only=on",
    });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      return await fn(
        async (sql, values = []) => (await client.query(sql, values)).rows,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }
  if (c.dialect === "mysql") {
    const client = await mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: c.database,
      ssl: c.tls ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      try {
        await client.query("SET SESSION MAX_EXECUTION_TIME=15000");
      } catch (e) {
        if (e.code !== "ER_UNKNOWN_SYSTEM_VARIABLE") throw e;
        await client.query("SET SESSION max_statement_time=15");
      }
      await client.query("START TRANSACTION READ ONLY");
      return await fn(
        async (sql, values = []) =>
          (await client.execute({ sql, timeout: 15000 }, values))[0],
      );
    } finally {
      await client.rollback().catch(() => {});
      await client.end();
    }
  }
  const pool = new mssql.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database,
    options: {
      encrypt: c.tls,
      trustServerCertificate: c.trustServerCertificate,
      appName: "BI tool setup",
    },
    connectionTimeout: 10000,
    requestTimeout: 15000,
    pool: { max: 1, min: 0 },
  });
  try {
    await pool.connect();
    return await fn(async (sql, values = []) => {
      const request = pool.request();
      values.forEach((value, index) => request.input(`p${index + 1}`, value));
      return (await request.query(sql)).recordset || [];
    });
  } finally {
    await pool.close();
  }
}
export async function listDatabases(config) {
  return withDatabase(config, async (query) => {
    const sql =
      config.dialect === "postgres"
        ? "SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname,'CONNECT') ORDER BY datname"
        : config.dialect === "mysql"
          ? "SHOW DATABASES"
          : "SELECT name FROM sys.databases WHERE state=0 AND HAS_DBACCESS(name)=1 ORDER BY name";
    const rows = await query(sql);
    return rows
      .map((r) => r.name || r.Database)
      .filter(
        (n) =>
          ![
            "information_schema",
            "mysql",
            "performance_schema",
            "sys",
            "master",
            "model",
            "msdb",
            "tempdb",
          ].includes(n),
      );
  });
}

export async function discoverDatabase(config) {
  return withDatabase(config, async (query) => {
    let rows, relations, procedures;
    if (config.dialect === "postgres") {
      rows =
        await query(`SELECT n.nspname AS schema_name,c.relname AS object_name,CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS data_type,NOT a.attnotnull AS nullable,
        EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname,a.attnum`);
      relations =
        await query(`SELECT con.oid::text AS relation_id,ns.nspname AS from_schema,s.relname AS from_table,nt.nspname AS to_schema,t.relname AS to_table,sa.attname AS from_column,ta.attname AS to_column,true AS target_unique
        FROM pg_constraint con JOIN pg_class s ON s.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=s.relnamespace JOIN pg_class t ON t.oid=con.confrelid JOIN pg_namespace nt ON nt.oid=t.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(s,t,ord) JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=k.s JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=k.t WHERE con.contype='f' AND con.convalidated ORDER BY con.oid,k.ord`);
      procedures = await query(
        `SELECT n.nspname AS schema_name,p.proname AS object_name,p.oid::text AS routine_id,pg_get_function_identity_arguments(p.oid) AS parameters FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='p' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_function_privilege(p.oid,'EXECUTE') ORDER BY n.nspname,p.proname,p.oid`,
      );
    } else if (config.dialect === "mysql") {
      rows = await query(
        `SELECT c.TABLE_SCHEMA AS schema_name,c.TABLE_NAME AS object_name,CASE WHEN t.TABLE_TYPE='VIEW' THEN 'view' ELSE 'table' END AS kind,c.COLUMN_NAME AS column_name,c.DATA_TYPE AS data_type,c.IS_NULLABLE='YES' AS nullable,c.COLUMN_KEY='PRI' AS primary_key FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=DATABASE() ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION`,
      );
      relations = await query(
        `SELECT k.CONSTRAINT_NAME AS relation_id,k.TABLE_SCHEMA AS from_schema,k.TABLE_NAME AS from_table,k.REFERENCED_TABLE_SCHEMA AS to_schema,k.REFERENCED_TABLE_NAME AS to_table,k.COLUMN_NAME AS from_column,k.REFERENCED_COLUMN_NAME AS to_column,EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS tc WHERE tc.CONSTRAINT_SCHEMA=r.UNIQUE_CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=r.UNIQUE_CONSTRAINT_NAME AND tc.TABLE_NAME=k.REFERENCED_TABLE_NAME AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE')) AS target_unique FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`,
      );
      procedures = await query(
        `SELECT ROUTINE_SCHEMA AS schema_name,ROUTINE_NAME AS object_name,SPECIFIC_NAME AS routine_id FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='PROCEDURE' ORDER BY ROUTINE_NAME`,
      );
      const params = await query(
        `SELECT SPECIFIC_NAME AS routine_id,PARAMETER_NAME AS name,DATA_TYPE AS type,PARAMETER_MODE AS mode FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=DATABASE() ORDER BY SPECIFIC_NAME,ORDINAL_POSITION`,
      );
      procedures.forEach((p) => {
        p.parameters = params.filter((r) => r.routine_id === p.routine_id);
      });
    } else {
      rows = await query(
        `SELECT s.name AS schema_name,o.name AS object_name,CASE WHEN o.type='V' THEN 'view' ELSE 'table' END AS kind,c.name AS column_name,ty.name AS data_type,c.is_nullable AS nullable,CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=o.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS primary_key FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1 ORDER BY s.name,o.name,c.column_id`,
      );
      relations = await query(
        `SELECT CAST(f.object_id AS varchar(30)) AS relation_id,ss.name AS from_schema,s.name AS from_table,ts.name AS to_schema,t.name AS to_table,sc.name AS from_column,tc.name AS to_column,CASE WHEN i.is_unique=1 THEN 1 ELSE 0 END AS target_unique FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id JOIN sys.tables s ON s.object_id=f.parent_object_id JOIN sys.schemas ss ON ss.schema_id=s.schema_id JOIN sys.tables t ON t.object_id=f.referenced_object_id JOIN sys.schemas ts ON ts.schema_id=t.schema_id JOIN sys.columns sc ON sc.object_id=s.object_id AND sc.column_id=fc.parent_column_id JOIN sys.columns tc ON tc.object_id=t.object_id AND tc.column_id=fc.referenced_column_id LEFT JOIN sys.indexes i ON i.object_id=t.object_id AND i.index_id=f.key_index_id WHERE f.is_disabled=0 AND f.is_not_trusted=0 ORDER BY f.object_id,fc.constraint_column_id`,
      );
      procedures = await query(
        `SELECT s.name AS schema_name,p.name AS object_name,CAST(p.object_id AS varchar(30)) AS routine_id FROM sys.procedures p JOIN sys.schemas s ON s.schema_id=p.schema_id WHERE p.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(p.name),'OBJECT','EXECUTE')=1 ORDER BY s.name,p.name`,
      );
      const params = await query(
        `SELECT CAST(p.object_id AS varchar(30)) AS routine_id,p.name AS name,t.name AS type,p.is_output AS output FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id ORDER BY p.object_id,p.parameter_id`,
      );
      procedures.forEach((p) => {
        p.parameters = params.filter((r) => r.routine_id === p.routine_id);
      });
    }
    const objects = new Map();
    for (const r of rows) {
      const id = `${r.schema_name}.${r.object_name}`;
      if (!objects.has(id))
        objects.set(id, {
          id,
          schema: r.schema_name,
          name: r.object_name,
          kind: r.kind,
          columns: [],
        });
      objects.get(id).columns.push({
        name: r.column_name,
        dataType: r.data_type,
        nullable: Boolean(r.nullable),
        isPrimaryKey: Boolean(r.primary_key),
        restricted: isProtectedColumn(r.column_name),
      });
    }
    for (const p of procedures)
      objects.set(`${p.schema_name}.${p.object_name}#${p.routine_id}`, {
        id: `${p.schema_name}.${p.object_name}#${p.routine_id}`,
        schema: p.schema_name,
        name: p.object_name,
        kind: "procedure",
        parameters: p.parameters || [],
        columns: [],
        executionBlocked: true,
      });
    if (objects.size > 2000 || rows.length > 30000)
      throw new Error(
        "Catalog too large. Use a database account scoped to the objects you need.",
      );
    const relationships = new Map();
    for (const r of relations) {
      const from = `${r.from_schema}.${r.from_table}`,
        to = `${r.to_schema}.${r.to_table}`;
      if (!objects.has(from) || !objects.has(to)) continue;
      const id = `${from}:${r.relation_id}`;
      if (!relationships.has(id))
        relationships.set(id, {
          id,
          from,
          to,
          targetUnique: Boolean(r.target_unique),
          columns: [],
        });
      relationships
        .get(id)
        .columns.push({ from: r.from_column, to: r.to_column });
    }
    const catalog = {
      objects: [...objects.values()],
      relationships: [...relationships.values()],
    };
    return namedKeyLinks({ ...catalog, fingerprint: fingerprint(catalog) });
  });
}
export async function executeTool(
  config,
  tool,
  catalog,
  parameters = {},
  limit = 50,
  offset = 0,
  options = {},
) {
  const compiled = compileTool(
    tool,
    catalog,
    config.dialect,
    parameters,
    limit,
    offset,
    options,
  );
  const started = Date.now();
  const result = await withDatabase(config, (query) =>
    query(compiled.sql, compiled.values),
  );
  return {
    rows: result
      .slice(0, compiled.limit)
      .map((row) =>
        Object.fromEntries(
          compiled.outputFields.map((name, i) => [name, row[`c${i}`]]),
        ),
      ),
    hasMore: result.length > compiled.limit,
    limit: compiled.limit,
    elapsedMs: Date.now() - started,
    scope: compiled.grain || (
      tool.mode === "aggregate"
        ? "Database aggregation; returned groups may be capped."
        : "Bounded preview, not the complete dataset."),
  };
}

/**
 * Reads EVERY row of an approved tool's result over one database
 * connection, in batches, for the full Excel export. Uses the same compiled,
 * parameterised query as the chat and paging, so the export always matches
 * what the report shows.
 */
export async function streamToolRows(config, tool, catalog, parameters, onBatch, batchSize = 5000) {
  return withDatabase(config, async (query) => {
    let offset = 0;
    let total = 0;
    for (;;) {
      const compiled = compileTool(tool, catalog, config.dialect, parameters, batchSize, offset, { maxLimit: batchSize });
      const result = await query(compiled.sql, compiled.values);
      const rows = result
        .slice(0, compiled.limit)
        .map((row) => Object.fromEntries(compiled.outputFields.map((name, i) => [name, row[`c${i}`]])));
      if (rows.length) await onBatch(rows, compiled.outputFields);
      total += rows.length;
      if (result.length <= compiled.limit) return { total, fields: compiled.outputFields };
      offset += compiled.limit;
    }
  });
}

export async function summarizeTool(config, tool, catalog, parameters = {}) {
  const compiled = compileTool(tool, catalog, config.dialect, parameters);
  const columns = new Map(
    catalog.objects.flatMap((o) =>
      o.columns.map((c) => [`${o.id}:${c.name}`, c]),
    ),
  );
  return withDatabase(config, async (query) => {
    const [count] = await query(
      summaryQuery(compiled, config.dialect),
      compiled.values,
    );
    let matchedRecords;
    if(tool.mode==='aggregate'){
      const base=catalog.objects.find(o=>o.id===tool.base);
      const key=base.columns.find(c=>c.isPrimaryKey&&!isProtectedColumn(c.name))||base.columns.find(c=>!isProtectedColumn(c.name));
      if(key){
        const field=tool.base+':'+key.name;
        const rowDefinition={...tool,mode:'rows',columns:[field],groupBy:[],metrics:[]};
        const plan=typeof parameters.query==='string'?JSON.parse(parameters.query):{};
        let rowParameters;
        if(tool.capabilities){
          const scope={...plan};for(const name of ['limit','sort','groupBy','metrics','dateGroups','columns','distinct'])delete scope[name];
          rowParameters={query:JSON.stringify({...scope,columns:[field]})};
        }else{
          delete rowDefinition.template;
          const values={...(plan.values||parameters)};delete values.query;
          for(const name of ['report_limit','report_columns','report_sort_field','report_sort_direction'])delete values[name];
          rowParameters={query:JSON.stringify({values})};
        }
        const rows=compileTool(rowDefinition,catalog,config.dialect,rowParameters);
        const [matched]=await query(summaryQuery(rows,config.dialect),rows.values);
        matchedRecords=Number(matched.population);
      }
    }
    const numeric = [];
    for (const [index, field] of compiled.outputFields.entries()) {
      if(compiled.unsafeAggregateFields?.includes(field))continue;
      const column = columns.get(field);
      const metric = !column;
      if (
        !metric &&
        (!numericType(column.dataType) ||
          column.isPrimaryKey ||
          /(?:^id$|id$|_sk$|code$)/i.test(column.name))
      )
        continue;
      const [statistics] = await query(
        summaryQuery(compiled, config.dialect, index),
        compiled.values,
      );
      numeric.push({
        title: field,
        statistics: {
          ...statistics,
          missing: Number(count.population) - Number(statistics.present),
        },
      });
    }
    return {
      population: count.population,
      ...(matchedRecords!==undefined?{matchedRecords}:{}),
      scope: compiled.grain || (
        tool.mode === "aggregate"
          ? "Full matching result groups"
          : "Full matching records"),
      numeric,
    };
  });
}
