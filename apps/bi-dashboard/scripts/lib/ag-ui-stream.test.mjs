import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunEvents, readEventStream, eventFrame } from './ag-ui-stream.mjs';

test('AG-UI text is incremental and final corrections replace the draft', () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.text('Hello'); run.text('Hello world'); run.finish({ narrative: 'Verified answer', data: {} });
  run.error('late');
  assert.deepEqual(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta), ['Hello', ' world']);
  assert.equal(events.find((e) => e.type === 'MESSAGES_SNAPSHOT').messages[0].content, 'Verified answer');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
});
test('SSE parser handles byte-split unicode and multiple events', async () => {
  const bytes = new TextEncoder().encode(eventFrame({ type: 'TEXT_MESSAGE_CONTENT', delta: 'café' }) + eventFrame({ type: 'RUN_FINISHED' }));
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const events = [];
  await readEventStream(stream, (e) => events.push(e));
  assert.equal(events[0].delta, 'café'); assert.equal(events[1].type, 'RUN_FINISHED');
});
test('failed runs cannot publish a success result', () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.error('Unavailable'); run.finish({ narrative: 'No' });
  assert.equal(events.at(-1).type, 'RUN_ERROR');
  assert.equal(events.some((e) => e.type === 'RUN_FINISHED'), false);
});
test('SSE handles CRLF split across chunks and heartbeat comments', async () => {
  const wire = ': heartbeat\r\n\r\n' + eventFrame({ type: 'RUN_FINISHED' }).replaceAll('\n', '\r\n');
  const stream = new ReadableStream({ start(c) { for (const char of wire) c.enqueue(new TextEncoder().encode(char)); c.close(); } });
  const events = [];
  await readEventStream(stream, (e) => events.push(e));
  assert.deepEqual(events, [{ type: 'RUN_FINISHED' }]);
});
test('parser cancels the reader if the run reports a failure', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(eventFrame({ type: 'RUN_ERROR', message: 'Failed' }))); }, cancel() { cancelled = true; } });
  await assert.rejects(readEventStream(stream, (e) => { throw new Error(e.message); }), /Failed/);
  assert.equal(cancelled, true);
});
