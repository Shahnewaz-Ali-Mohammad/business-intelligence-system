import { quote } from "./model.mjs";
export function summaryQuery(compiled, dialect, index) {
  const source = compiled.populationSql;
  const q = (name) => quote(name, dialect);
  const count = dialect === "sqlserver" ? "COUNT_BIG" : "COUNT";
  if (index === undefined)
    return `SELECT ${count}(*) AS population FROM (${source}) AS ${q("population")}`;
  const value = q(`c${index}`);
  return `WITH population AS (${source}), ranked AS (SELECT CAST(${value} AS DECIMAL(38,6)) AS value, ROW_NUMBER() OVER (ORDER BY ${value}) AS rn, ${count}(*) OVER () AS n FROM population WHERE ${value} IS NOT NULL) SELECT ${count}(*) AS present, MIN(value) AS minimum, MAX(value) AS maximum, AVG(value) AS average, SUM(value) AS total, AVG(CASE WHEN rn IN (FLOOR((n+1)/2.0), FLOOR((n+2)/2.0)) THEN value END) AS median FROM ranked`;
}
