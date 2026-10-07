import { getWarehousePool } from '../src/config/db.mjs';
import { CUBE_CATALOG } from '../src/semantic/cubeCatalog.mjs';
import { querySemanticLayer } from '../src/services/cubeQueryService.mjs';
import assert from 'node:assert/strict';

const pool = getWarehousePool();
try {
  const { rows } = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
  const missingModelColumns = CUBE_CATALOG.filter((cube) => cube.table).flatMap((cube) => cube.dimensions.filter((d) => !rows.some((row) => row.table_name === cube.table && row.column_name === d.name.split('.')[1])).map((d) => d.name));
  const unmodeledBusinessColumns = rows.filter((row) => /^(dim_|fact_)/.test(row.table_name) && !CUBE_CATALOG.some((cube) => cube.table === row.table_name && cube.dimensions.some((d) => d.name.split('.')[1] === row.column_name)));
  console.log(JSON.stringify({ modeledTables: CUBE_CATALOG.map((c) => c.table), missingModelColumns, unmodeledBusinessColumns }, null, 2));
  if (missingModelColumns.length || unmodeledBusinessColumns.length) process.exitCode = 1;
  if (process.argv.includes('--counts')) {
    for (const cube of CUBE_CATALOG.filter((c) => c.table)) {
      const measure = cube.measures.find((m) => m.type === 'count' && !m.name.endsWith('.active_customer_count'));
      assert.ok(measure, `Missing count measure for ${cube.name}`);
      // Table identifiers come exclusively from the trusted local model.
      const expected = await pool.query(`SELECT count(*) AS n FROM ${cube.table}`);
      const actual = await querySemanticLayer({ measures: [measure.name] });
      assert.equal(Number(actual[0]?.[measure.name]), Number(expected.rows[0].n), `${cube.name} count differs from warehouse`);
      console.log(JSON.stringify({ cube: cube.name, count: Number(expected.rows[0].n), passed: true }));
    }
  }
} finally {
  await pool.end();
}
