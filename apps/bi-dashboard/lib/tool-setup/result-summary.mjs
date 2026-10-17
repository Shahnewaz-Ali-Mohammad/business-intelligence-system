import { quote, numericType } from "./model.mjs";
export function isSummaryMeasure(field, column, mode) {
  if (!column) return true;
  return mode !== 'aggregate' && numericType(column.dataType) && !column.isPrimaryKey && !/(?:^id$|id$|_sk$|code$)/i.test(column.name);
}
export function groupingCoverageQuery(compiled, dialect, index, text = false) {
  const q = (name) => quote(name, dialect);
  const value = q(`c${index}`);
  const bigint = dialect === 'sqlserver' ? 'BIGINT' : 'DECIMAL(38,0)';
  return `SELECT SUM(CAST(CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END AS ${bigint})) AS missing_groups, ${text ? `SUM(CAST(CASE WHEN ${value} = '' THEN 1 ELSE 0 END AS ${bigint}))` : '0'} AS empty_groups FROM (${compiled.populationSql}) AS ${q('population')}`;
}
export function summaryQuery(compiled, dialect, index) {
  const source = compiled.populationSql;
  const q = (name) => quote(name, dialect);
  const count = dialect === "sqlserver" ? "COUNT_BIG" : "COUNT";
  if (index === undefined)
    return `SELECT ${count}(*) AS population FROM (${source}) AS ${q("population")}`;
  const value = q(`c${index}`);
  return `WITH population AS (${source}), ranked AS (SELECT CAST(${value} AS DECIMAL(38,6)) AS value, ROW_NUMBER() OVER (ORDER BY ${value}) AS rn, ${count}(*) OVER () AS n FROM population WHERE ${value} IS NOT NULL) SELECT ${count}(*) AS present, MIN(value) AS minimum, MAX(value) AS maximum, AVG(value) AS average, SUM(value) AS total, AVG(CASE WHEN rn IN (FLOOR((n+1)/2.0), FLOOR((n+2)/2.0)) THEN value END) AS median FROM ranked`;
}
