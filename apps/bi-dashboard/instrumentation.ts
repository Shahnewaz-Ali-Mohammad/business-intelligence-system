// Starts the built-in report scheduler when the server starts. Every minute
// it runs any saved report whose scheduled time has arrived, so schedules
// work whenever the app is running. n8n (or any other caller of
// /api/automation/run-due) is optional; overlapping calls never run a report
// twice because each run is claimed first.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.BI_INTERNAL_SCHEDULER === 'off') return;
  const state = globalThis as typeof globalThis & { __biScheduler?: ReturnType<typeof setInterval> };
  if (state.__biScheduler) return;
  const { runDueReports } = await import('./lib/schedules/run-scheduled');
  const { devLog } = await import('./lib/dev-log.mjs');
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runDueReports();
      if (result.due) devLog('scheduler', result);
    } catch (error) {
      console.error('[scheduler] run failed:', error instanceof Error ? error.message : error);
    } finally { busy = false; }
  };
  // Aligned to the start of each minute so a 17:36 schedule runs at 17:36.
  setTimeout(() => { void tick(); state.__biScheduler = setInterval(() => void tick(), 60_000); }, 60_000 - (Date.now() % 60_000) + 2_000);
  state.__biScheduler = setTimeout(() => {}, 0) as unknown as ReturnType<typeof setInterval>;
}
