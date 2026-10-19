import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpAgent } from '@ag-ui/client';
import { createRunEvents, readEventStream, eventFrame, errorCode } from './ag-ui-stream.mjs';

// Plays recorded events through the official AG-UI client, which rejects any
// stream that breaks the protocol (unclosed steps, tool calls or messages).
async function playThroughClient(events) {
  const body = events.map(eventFrame).join('');
  class Agent extends HttpAgent { requestInit() { return { method: 'POST', body: '{}', signal: this.abortController.signal }; } }
  const agent = new Agent({ url: 'http://test/', fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const seen = []; let result; let failure;
  await agent.runAgent({}, {
    onEvent: ({ event }) => { seen.push(event.type); },
    onRunFinishedEvent: (params) => { result = params.result; },
    onRunErrorEvent: ({ event }) => { failure = event; },
  });
  return { seen, result, failure, agent };
}

test('text is incremental and a rewrite is sent as a snapshot', () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.text('Hello'); run.text('Hello world'); run.finish({ narrative: 'Verified answer', data: {} });
  run.error('late');
  assert.deepEqual(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta), ['Hello', ' world']);
  assert.equal(events.find((e) => e.type === 'MESSAGES_SNAPSHOT').messages[0].content, 'Verified answer');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
  assert.deepEqual(events.at(-1).result, { narrative: 'Verified answer', data: {} });
});

test('a full answer with steps, a tool call and early state passes the official client', async () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.step('Understanding your question');
  run.step('Reading the database');
  const call = run.toolStart({ name: 'billing_aggregate', label: 'Customer Billing (summary)', args: { groupBy: ['Month'] } });
  run.toolEnd(call, { rows: 12 });
  run.state({ preview: { rows: [{ a: 1 }] } });
  run.step('Preparing insights');
  run.text('Found 12 groups.'); run.text('Found 12 groups. Billing grew.');
  run.finish({ narrative: 'Found 12 groups. Billing grew.' });
  const { seen, result, failure, agent } = await playThroughClient(events);
  assert.equal(failure, undefined);
  assert.equal(result.narrative, 'Found 12 groups. Billing grew.');
  assert.deepEqual(agent.state, { preview: { rows: [{ a: 1 }] } });
  assert.equal(seen.filter((t) => t === 'STEP_STARTED').length, 3);
  assert.equal(seen.filter((t) => t === 'STEP_FINISHED').length, 3);
  assert.ok(seen.includes('TOOL_CALL_RESULT'));
  const toolResult = JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT').content);
  assert.equal(toolResult.rows, 12); assert.equal(toolResult.label, 'Customer Billing (summary)');
});

test('open steps and tool calls are closed before the run ends', async () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.step('Querying'); run.toolStart({ name: 'q', label: 'Query' }); run.text('Partial');
  run.error('Could not finish', 'timeout');
  const { failure } = await playThroughClient(events);
  assert.equal(failure.code, 'timeout');
  assert.equal(events.some((e) => e.type === 'RUN_FINISHED'), false);
});

test('repeating a stage name does not start a new stage, and steps report durations', () => {
  const run = createRunEvents(() => {}, { threadId: 't', runId: 'r', messageId: 'm' });
  run.step('A'); run.step('A'); run.step('B');
  const steps = run.steps();
  assert.deepEqual(steps.map((s) => s.name), ['A', 'B']);
  assert.ok(steps.every((s) => Number.isFinite(s.ms)));
});

test('failed runs cannot publish a success result', () => {
  const events = [];
  const run = createRunEvents((e) => events.push(e), { threadId: 't', runId: 'r', messageId: 'm' });
  run.error('Unavailable'); run.finish({ narrative: 'No' });
  assert.equal(events.at(-1).type, 'RUN_ERROR');
  assert.equal(events.some((e) => e.type === 'RUN_FINISHED'), false);
});

test('SSE parser handles byte-split unicode, CRLF and heartbeat comments', async () => {
  const wire = ': heartbeat\r\n\r\n' + eventFrame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'café' }).replaceAll('\n', '\r\n') + eventFrame({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' });
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const events = [];
  await readEventStream(stream, (e) => events.push(e));
  assert.equal(events[0].delta, 'café'); assert.equal(events[1].type, 'RUN_FINISHED');
});

test('parser cancels the reader if the handler fails', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(eventFrame({ type: 'RUN_ERROR', message: 'Failed' }))); }, cancel() { cancelled = true; } });
  await assert.rejects(readEventStream(stream, (e) => { throw new Error(e.message); }), /Failed/);
  assert.equal(cancelled, true);
});

test('error codes', () => {
  assert.equal(errorCode(new Error('Approval changed')), 'approval_changed');
  assert.equal(errorCode(new Error('Schema changed')), 'schema_changed');
  assert.equal(errorCode(new Error('Query exceeds the row limit')), 'too_large');
  assert.equal(errorCode(new Error('x'), { aborted: true }), 'timeout');
  assert.equal(errorCode(new Error('x')), 'failed');
});
