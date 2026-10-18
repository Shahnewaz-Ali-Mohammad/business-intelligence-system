import path from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { getAppDb } from '@/lib/db/app-db';
import { readRun, writeRun, pruneRuns, requestCancel, runDirectory } from './procedure-run-store.mjs';
import { stoppedRunMessage } from './procedure-lifecycle.mjs';

/** Starts the background worker for a queued procedure run. */
export function launchProcedureRun(workspaceId: string, runId: string) {
  const log = openSync(path.join(runDirectory(workspaceId, runId), 'worker.log'), 'a', 0o600);
  let worker: ReturnType<typeof spawn>;
  try {
    worker = spawn(process.execPath, [path.join(process.cwd(), 'scripts/procedure-run-worker.mjs'), workspaceId, runId], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', log, log] });
  } finally { closeSync(log); }
  worker.on('error', () => { void readRun(workspaceId, runId).then((run) => run && run.status === 'queued' ? writeRun(workspaceId, { ...run, status: 'failed', error: 'Could not start the report worker.' }) : null); });
  worker.on('exit', (code, signal) => {
    void readRun(workspaceId, runId).then(run => run && ['queued', 'running'].includes(run.status) ? writeRun(workspaceId, { ...run, status: 'failed', finishedAt: Date.now(), workerExitCode: code, workerExitSignal: signal, error: `The report worker exited before completing (${signal || `exit ${code}`}). Check database status before retrying.`, progress: 'Failed' }) : null).catch(error => console.error('[procedure worker exit]', error));
  });
  worker.unref();
}

/** Current run state; a run whose worker stopped reporting is marked failed. */
export async function procedureRunStatus(workspaceId: string, runId: string) {
  let run = await readRun(workspaceId, runId);
  const failure = run && stoppedRunMessage(run);
  if (failure) {
    await requestCancel(workspaceId, runId);
    run = await writeRun(workspaceId, { ...run, status: 'failed', error: failure, progress: 'Failed', finishedAt: Date.now() });
  }
  return run;
}

/** Deletes old unsaved runs; runs used by a saved report are kept. */
export async function pruneProcedureRuns(workspaceId: string, userId: number | string) {
  const [rows] = await getAppDb().execute("SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.workspaceToolAnswer.procedure.runId')) AS runId FROM generated_reports WHERE user_id=? AND JSON_EXTRACT(data, '$.workspaceToolAnswer.procedure.runId') IS NOT NULL", [userId]);
  await pruneRuns(workspaceId, new Set((rows as { runId: string }[]).map((r) => r.runId)));
}
