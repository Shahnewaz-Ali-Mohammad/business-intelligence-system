export function stoppedRunMessage(run, now = Date.now()) {
  if (run.status === 'queued' && now - run.createdAt > 60000) return 'The report worker did not start. No execution was confirmed; check the run before retrying.';
  if (run.status === 'running' && now - (run.heartbeatAt || 0) > 120000) return 'Contact with the report worker was lost. Cancellation was requested; verify database status before retrying.';
  return null;
}
