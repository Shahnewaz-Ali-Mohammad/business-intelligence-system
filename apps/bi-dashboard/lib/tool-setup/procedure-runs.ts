import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAppDb } from '@/lib/db/app-db';
import { readRun, writeRun, pruneRuns } from './procedure-run-store.mjs';

/** Starts the background worker for a queued procedure run. */
export function launchProcedureRun(workspaceId: string, runId: string) {
  const worker = spawn(process.execPath, [path.join(process.cwd(), 'scripts/procedure-run-worker.mjs'), workspaceId, runId], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' });
  worker.on('error', () => { void readRun(workspaceId, runId).then((run) => run && run.status === 'queued' ? writeRun(workspaceId, { ...run, status: 'failed', error: 'Could not start the report worker.' }) : null); });
  worker.unref();
}

/** Current run state; a run whose worker stopped reporting is marked failed. */
export async function procedureRunStatus(workspaceId: string, runId: string) {
  let run = await readRun(workspaceId, runId);
  if (run && run.status === 'running' && Date.now() - (run.heartbeatAt || 0) > 120000) {
    run = await writeRun(workspaceId, { ...run, status: 'failed', error: 'The report worker stopped responding. Run the report again.', progress: 'Failed' });
  }
  return run;
}

/** Deletes old unsaved runs; runs used by a saved report are kept. */
export async function pruneProcedureRuns(workspaceId: string, userId: number | string) {
  const [rows] = await getAppDb().execute("SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.workspaceToolAnswer.procedure.runId')) AS runId FROM generated_reports WHERE user_id=? AND JSON_EXTRACT(data, '$.workspaceToolAnswer.procedure.runId') IS NOT NULL", [userId]);
  await pruneRuns(workspaceId, new Set((rows as { runId: string }[]).map((r) => r.runId)));
}
