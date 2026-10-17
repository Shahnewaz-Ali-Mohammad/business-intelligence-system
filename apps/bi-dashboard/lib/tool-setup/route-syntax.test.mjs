import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('every API route parses, including routes outside the unit-test import graph', () => {
  const root = fileURLToPath(new URL('../../app/api/', import.meta.url));
  function check(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (entry.name === 'route.ts') {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        assert.deepEqual(source.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], path);
      }
    }
  }
  check(root);
});
