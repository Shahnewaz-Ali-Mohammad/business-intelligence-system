import test from 'node:test';
import assert from 'node:assert/strict';
import { pgIdentifier, sqlIdentifier, copyField, postgresType, sourceExpression } from './rawCopy.mjs';

test('metadata identifiers are quoted, not interpolated as SQL syntax', () => {
  assert.equal(pgIdentifier('a"b'), '"a""b"');
  assert.equal(sqlIdentifier('a]b'), '[a]]b]');
});
test('COPY text preserves nulls, empty strings, escapes, Unicode and binary', () => {
  assert.equal(copyField(null), '\\N');
  assert.equal(copyField(''), '');
  assert.equal(copyField('\\N'), '\\\\N');
  assert.equal(copyField('a\tb\nc\rd\\e'), 'a\\tb\\nc\\rd\\\\e');
  assert.equal(copyField('বাংলা'), 'বাংলা');
  assert.equal(copyField(Buffer.from([0, 255])), '\\\\x00ff');
  assert.equal(copyField(false), 'f');
  assert.throws(() => copyField('a\0b'), /NUL/);
});
test('decimal and source bigint values avoid Javascript rounding', () => {
  assert.equal(postgresType({ data_type: 'decimal', numeric_precision: 38, numeric_scale: 8 }), 'numeric(38,8)');
  assert.match(sourceExpression({ column_name: 'ID', data_type: 'bigint' }), /CONVERT\(varchar\(100\)/);
  assert.match(sourceExpression({ column_name: 'Added', data_type: 'datetime' }), /126/);
  assert.throws(() => postgresType({ data_type: 'unknown' }), /Unsupported/);
});
