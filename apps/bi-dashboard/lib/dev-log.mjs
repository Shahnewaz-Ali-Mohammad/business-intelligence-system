// Development-only trace of workspace chat steps (never written in production).
export function devLog(label, value) {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_TEST_CONTEXT) return;
  try { process.getBuiltinModule('node:fs').appendFileSync(process.cwd() + '/workspace-chat.log', `${new Date().toISOString()} ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`.slice(0, 60000) + '\n'); } catch {}
}
