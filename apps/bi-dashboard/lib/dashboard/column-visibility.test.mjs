import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleColumnIndexes, projectColumns, exportHiddenColumns } from './column-visibility.mjs';

test('hiding and restoring columns preserves values and source data', () => {
  const headers = ['POP Name', 'Bandwidth', 'POP ID'];
  const rows = [['North', 0, 12], ['South', null, 13]];
  assert.deepEqual(projectColumns(headers, rows, ['POP ID']), { headers: ['POP Name', 'Bandwidth'], rows: [['North', 0], ['South', null]] });
  assert.deepEqual(projectColumns(headers, rows, []), { headers, rows });
  assert.equal(rows[0][2], 12);
});
test('all hidden, old snapshots, stale fields and empty reports are supported', () => {
  assert.deepEqual(visibleColumnIndexes(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(visibleColumnIndexes(['a', 'b'], ['old']), [0, 1]);
  assert.deepEqual(visibleColumnIndexes(['a']), [0]);
  assert.deepEqual(projectColumns([], [], ['old']), { headers: [], rows: [] });
});
test('export column options cannot inject SQL and malformed values are ignored', () => {
  assert.deepEqual(exportHiddenColumns(new URLSearchParams({ hiddenColumns: '["a",42,null]' })), ['a']);
  assert.deepEqual(exportHiddenColumns(new URLSearchParams({ hiddenColumns: '{' })), []);
  assert.deepEqual(projectColumns(['a', 'b'], [[1, 2]], ['DROP TABLE x']), { headers: ['a', 'b'], rows: [[1, 2]] });
});
