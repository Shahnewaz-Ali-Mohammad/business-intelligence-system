// ============================================================================
// Main ETL entrypoint. Run this once daily (see scripts/run-daily-sync.sh
// for the cron wrapper). This file just orchestrates — all real logic
// lives in src/etl/tables/*.js.
//
// Order matters: dimensions/reference tables sync first, since facts
// reference them via foreign keys (dim_customer must exist before
// fact_billing rows referencing those customers can be inserted).
// ============================================================================

import { syncPopMaster, syncPackageMaster, syncStatusMaster, syncRegion, syncTicketType } from './tables/referenceTables.mjs';
import { syncCustomerMaster } from './tables/customerMaster.mjs';
import { syncBillingMaster } from './tables/billingMaster.mjs';
import { syncTickets } from './tables/tickets.mjs';

async function runSync() {
  const startedAt = new Date();
  console.log(`[ETL] Daily sync started at ${startedAt.toISOString()}`);

  const steps = [
    { name: 'Reference: POPMaster', fn: syncPopMaster },
    { name: 'Reference: PackageMaster', fn: syncPackageMaster },
    { name: 'Reference: StatusMaster', fn: syncStatusMaster },
    { name: 'Reference: Division/District', fn: syncRegion },
    // FIX 2026-09-15: dim_ticket_type was defined in the schema from the
    // start but never actually synced by anything -- see
    // referenceTables.mjs's syncTicketType comment for why it's safe now
    // (Tk_TicketType confirmed to exist in TicketingDB, same-DB FK to the
    // ticket_type_id already landing in fact_ticket).
    { name: 'Reference: Tk_TicketType', fn: syncTicketType },
    { name: 'Dimension: CustomerMaster', fn: syncCustomerMaster },
    { name: 'Fact: BillingMaster (billing/collection/refund/adjustment)', fn: syncBillingMaster },
    { name: 'Fact: Tickets', fn: syncTickets },
  ];

  const results = [];
  for (const step of steps) {
    try {
      console.log(`[ETL] Running: ${step.name}`);
      const result = await step.fn();
      console.log(`[ETL]   -> ${result.rowCount} rows synced`);
      results.push({ ...step, ...result, status: 'success' });
    } catch (error) {
      // Deliberately do NOT stop the whole run on one table's failure —
      // other tables should still get their chance to sync. The failed
      // table's watermark didn't advance (see syncLog.js), so it retries
      // cleanly on the next daily run.
      console.error(`[ETL]   -> FAILED: ${error.message}`);
      results.push({ ...step, status: 'failed', error: error.message });
    }
  }

  const finishedAt = new Date();
  const failedSteps = results.filter((r) => r.status === 'failed');
  console.log(`[ETL] Daily sync finished at ${finishedAt.toISOString()} (${(finishedAt - startedAt) / 1000}s)`);
  if (failedSteps.length) {
    console.error(`[ETL] ${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.name).join(', ')}`);
    process.exitCode = 1; // lets the cron wrapper / monitoring detect a bad run
  }
}

runSync().catch((error) => {
  console.error('[ETL] Fatal error, sync aborted:', error);
  process.exit(1);
});
