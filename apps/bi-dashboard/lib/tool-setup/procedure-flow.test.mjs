import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stoppedRunMessage } from './procedure-lifecycle.mjs';
import { aggregateProcedureGraph } from './procedure-graph.mjs';
import { bindProcedureParameters, resultColumns, streamReportProcedure } from './sqlserver-procedure-runner.mjs';
import { fallbackInsight, groundedNarrative } from '../../scripts/lib/analytical-insight.mjs';

test('startup failure and stale heartbeat are reported without automatic retries', () => {
  assert.match(stoppedRunMessage({ status: 'queued', createdAt: 1 }, 70000), /did not start/);
  assert.equal(stoppedRunMessage({ status: 'queued', createdAt: 1 }, 100), null);
  assert.match(stoppedRunMessage({ status: 'running', heartbeatAt: 1 }, 130000), /verify database status/);
  assert.equal(stoppedRunMessage({ status: 'completed', createdAt: 1 }, 900000), null);
});

test('procedure graphs scan all rows, preserve zero and NULL, and validate fields', async () => {
  async function* rows() { for (let i = 0; i < 250; i++) yield { Group: i % 2 ? 'A' : 'B', Amount: i % 2 ? 2 : 0 }; }
  const graph = await aggregateProcedureGraph(rows(), ['Group', 'Amount'], { category: 'Group', metric: 'Amount', aggregation: 'sum' });
  assert.equal(graph.population, 250);
  assert.deepEqual(graph.rows, [{ category: 'A', value: 250 }, { category: 'B', value: 0 }]);
  const mean = await aggregateProcedureGraph([{ Group: 'A', Amount: null }, { Group: 'A', Amount: 4 }], ['Group', 'Amount'], { category: 'Group', metric: 'Amount', aggregation: 'avg' });
  assert.equal(mean.rows[0].value, 4);
  await assert.rejects(aggregateProcedureGraph([], ['Group'], { category: 'injected' }));
});

test('native RPC bindings omit defaults and capture outputs without string SQL', () => {
  const input = []; const output = [];
  const request = { input: (...args) => input.push(args), output: (...args) => output.push(args) };
  bindProcedureParameters(request, { parameters: [{ name: '@Optional', type: 'int' }, { name: '@Name', type: 'nvarchar', maxLength: 100 }, { name: '@Total', type: 'decimal', output: true }] }, { '@Name': "name'; DELETE FROM business;--" }, ['@Optional']);
  assert.equal(input.length, 1); assert.equal(input[0][0], 'Name');
  assert.equal(input[0][2], "name'; DELETE FROM business;--");
  assert.equal(output[0][0], 'Total');
  assert.equal(output[0][1].length, 65535);
});

test('browser date inputs gain SQL-compatible seconds without rounding precision or offsets', () => {
  const input = [];
  const request = { input: (name, type, value) => input.push([name, value]) };
  const parameters = [
    { name: '@Start', type: 'datetime' }, { name: '@DateOnly', type: 'datetime' },
    { name: '@Precise', type: 'datetime2' }, { name: '@Offset', type: 'datetimeoffset' },
    { name: '@Time', type: 'time' }, { name: '@Null', type: 'datetime' },
  ];
  bindProcedureParameters(request, { parameters }, { '@Start': '2025-03-18T16:37', '@DateOnly': '2025-03-18', '@Precise': '2025-03-18T16:37:12.1234567', '@Offset': '2025-03-18T16:37+06:00', '@Time': '16:37', '@Null': null });
  assert.deepEqual(input, [['Start', '2025-03-18T16:37:00'], ['DateOnly', '2025-03-18T00:00:00'], ['Precise', '2025-03-18T16:37:12.1234567'], ['Offset', '2025-03-18T16:37:00+06:00'], ['Time', '16:37:00'], ['Null', null]]);
});

test('duplicate and unnamed result columns retain separate cells; credentials are hidden', () => {
  const mapping = resultColumns([{ name: 'Name' }, { name: 'Name' }, { name: '' }, { name: 'Password' }]);
  assert.deepEqual(mapping.map(column => column.name), ['Name', 'Name (2)', 'Column 3', 'Password']);
  assert.equal(mapping[3].hidden, true);
});

test('streamed SQL errors reject the report instead of crashing or reporting success', async () => {
  const previous = process.env.SOURCE_DATABASE_ALLOWED_HOSTS;
  process.env.SOURCE_DATABASE_ALLOWED_HOSTS = '127.0.0.1';
  let closed = false;
  class Request extends EventEmitter {
    async execute() { this.emit('error', new Error('SQL conversion failed')); return { output: {} }; }
    cancel() {}
  }
  class Pool extends EventEmitter {
    async connect() {}
    request() { return new Request(); }
    async close() { closed = true; }
  }
  try {
    await assert.rejects(streamReportProcedure({ dialect: 'sqlserver', host: '127.0.0.1', port: 1433, username: 'test', password: 'test', database: 'test', tls: true }, { schema: 'dbo', name: 'Report', parameters: [] }, {}, [], { driver: { ConnectionPool: Pool } }), /SQL conversion failed/);
    assert.equal(closed, true);
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATABASE_ALLOWED_HOSTS;
    else process.env.SOURCE_DATABASE_ALLOWED_HOSTS = previous;
  }
});

test('estimated medians cannot be presented as exact statistics', () => {
  const summary = { numeric: [{ title: 'Amount', statistics: { average: 5, median: 4, minimum: 1, maximum: 10, medianEstimated: true } }] };
  assert.match(fallbackInsight(summary), /estimated median/);
  assert.throws(() => groundedNarrative('The median is 4.', summary), /Estimated median/);
});

test('stored procedure result pages preserve every row across UTF-8 page boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bi-result-pages-'));
  process.env.BI_PROCEDURE_RUN_DIR = root;
  const store = await import(`./procedure-run-store.mjs?test=${Date.now()}`);
  const workspace = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  try {
    const run = await store.createRun(workspace, { userId: 1 });
    const writer = await store.openResultWriter(workspace, run.id, 0);
    for (let i = 0; i < 251; i++) await writer.add({ id: i, text: `row ${i} বাংলা` });
    await writer.close();
    const second = await store.readResultPage(workspace, run.id, 0, 2);
    assert.equal(second.length, 100); assert.equal(second[0].id, 100); assert.equal(second[99].id, 199);
    const last = await store.readResultPage(workspace, run.id, 0, 3);
    assert.equal(last.length, 51); assert.equal(last[50].id, 250);
    let count = 0; for await (const row of store.resultRows(workspace, run.id, 0)) { assert.equal(row.id, count); count++; }
    assert.equal(count, 251);
  } finally { delete process.env.BI_PROCEDURE_RUN_DIR; await rm(root, { recursive: true, force: true }); }
});
