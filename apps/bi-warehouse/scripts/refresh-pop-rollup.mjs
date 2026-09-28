// One-off / manual helper: refreshes mart_pop_daily_financials on demand,
// for right after the schema migration first creates it (before the
// nightly ETL sync's own refresh step -- see src/etl/lib/materializedViews.mjs
// -- would otherwise be the first thing to populate it).
// Run with: node scripts/refresh-pop-rollup.mjs
import 'dotenv/config';
import pg from 'pg';

async function main() {
  const client = new pg.Client({
    host: process.env.WAREHOUSE_PG_HOST,
    port: Number(process.env.WAREHOUSE_PG_PORT || 5432),
    database: process.env.WAREHOUSE_PG_DATABASE,
    user: process.env.WAREHOUSE_PG_USER,
    password: process.env.WAREHOUSE_PG_PASSWORD,
  });
  await client.connect();
  console.log(`[refresh] Connected to ${process.env.WAREHOUSE_PG_DATABASE}@${process.env.WAREHOUSE_PG_HOST}`);
  console.log('[refresh] Refreshing mart_pop_daily_financials -- this can take a while the first time...');
  const startedAt = Date.now();
  // Plain REFRESH (not CONCURRENTLY) on purpose for this first manual run --
  // CONCURRENTLY requires the view to already hold at least one row to diff
  // against, which a brand-new view never does yet.
  await client.query('REFRESH MATERIALIZED VIEW mart_pop_daily_financials');
  console.log(`[refresh] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  await client.end();
}

main().catch((error) => {
  console.error('[refresh] Failed:', error.message);
  process.exit(1);
});
