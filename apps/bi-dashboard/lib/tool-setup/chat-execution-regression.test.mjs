import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspace chat publishes a preview before statistics and reuses the verified execution', async () => {
  const route = await readFile(new URL('../../app/api/workspaces/[id]/chat/route.ts', import.meta.url), 'utf8');
  const execution = route.slice(route.indexOf("devLog('tool-call'"), route.indexOf('const client = new Client'));
  assert.ok(execution.indexOf('run.state(') < execution.indexOf('await summarizeTool('));
  assert.match(execution, /result: preview, summary/);
  const final = route.slice(route.indexOf('run.progress("Preparing the report")'));
  assert.match(final, /await approvedNow\(completed.toolId\)/);
  assert.match(final, /const result = completed.result/);
  assert.match(final, /const summary = completed.summary/);
  assert.doesNotMatch(final, /await (executeTool|summarizeTool)\(/);
});
