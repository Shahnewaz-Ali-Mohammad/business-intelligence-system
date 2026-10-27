import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProcedure, procedureHash, procedureDefaults, authorizeProcedureRun, validateProcedureValues, sqlTokens } from './report-procedures.mjs';

test('reporting SQL including local temporary tables and variables can be reviewed', () => {
  assert.equal(reviewProcedure('CREATE PROCEDURE dbo.Report @StartDate date AS BEGIN SELECT Name FROM dbo.Customer WHERE Created>=@StartDate END').allowed, true);
  for (const definition of ['CREATE OR ALTER PROC dbo.Report AS CREATE TABLE #temp(id int); INSERT INTO #temp VALUES(1); UPDATE #temp SET id=2; DELETE FROM #temp; DROP TABLE IF EXISTS #temp;', 'ALTER PROC dbo.Report AS SELECT 1 INTO [#report]; SELECT * FROM #report;', 'CREATE PROC dbo.Report AS DECLARE @t TABLE(id int); INSERT @t VALUES(1); SELECT * FROM @t;']) {
    assert.equal(reviewProcedure(definition).requiresWriteConsent, false, definition);
  }
  assert.equal(reviewProcedure(null).allowed, false);
});
test('business writes, dynamic calls and global temporary tables require per-run consent', () => {
  for (const statement of ['DELETE FROM dbo.Customer', 'UPDATE dbo.Customer SET Name=1', "EXEC sp_executesql N'SELECT 1'", 'SELECT * INTO dbo.NewTable FROM dbo.Customer', 'CREATE TABLE ##shared(id int)', 'INSERT INTO [dbo].[data] VALUES(1)', 'SELECT NEXT VALUE FOR dbo.Counter']) {
    const reviewed = reviewProcedure(`CREATE PROC dbo.Report AS BEGIN ${statement}; END`);
    assert.equal(reviewed.allowed, true);
    assert.equal(reviewed.requiresWriteConsent, true, statement);
    const procedure = { ...reviewed, hash: 'current' };
    assert.throws(() => authorizeProcedureRun(procedure, 'current', { hash: 'current' }), /authorization/);
    assert.doesNotThrow(() => authorizeProcedureRun(procedure, 'current', { hash: 'current', allowBusinessWrites: true }));
    assert.doesNotThrow(() => authorizeProcedureRun(procedure, null, { hash: 'current', allowBusinessWrites: true }));
    assert.throws(() => authorizeProcedureRun(procedure, 'current', { hash: 'old', allowBusinessWrites: true }), /changed/);
  }
});
test('comments, quoted keywords and SQL strings do not masquerade as executable tokens', () => {
  assert.equal(reviewProcedure("/* outer /* inner */ done */ CREATE PROC [DROP] AS SELECT 'DELETE -- text' AS [UPDATE];").requiresWriteConsent, false);
  assert.throws(() => sqlTokens("SELECT 'unfinished"));
  assert.equal(reviewProcedure('CREATE PROC x AS /* unclosed').allowed, false);
});
test('defaults are discovered only in the parameter declaration, not the body', () => {
  const parameters = [{ name: '@Amount' }, { name: '@Label' }, { name: '@Required' }];
  assert.deepEqual(procedureDefaults("CREATE PROC x @Amount decimal(20,6)=12.000001, @Label nvarchar(50)=N'a,b', @Required int AS BEGIN SET @Required=2; END", parameters), { '@Amount': true, '@Label': true });
  assert.deepEqual(validateProcedureValues([{ name: '@Optional', type: 'int' }, { name: '@Result', type: 'int', output: true }], {}, ['@Optional']), [undefined, undefined]);
});
test('procedure definitions have a new hash whenever the body changes', () => {
  assert.notEqual(procedureHash('SELECT 1'), procedureHash('SELECT 2'));
});
test('structured table parameters validate columns, nullability and data types', () => {
  const parameters = [{ name: '@Items', tableType: 'dbo.Items', tableColumns: [{ name: 'id', type: 'int', nullable: false }, { name: 'note', type: 'nvarchar', nullable: true }] }];
  assert.deepEqual(validateProcedureValues(parameters, { '@Items': [{ id: 2, note: null }] }), [[['2', null]]]);
  assert.throws(() => validateProcedureValues(parameters, { '@Items': [{ note: 'missing ID' }] }));
  assert.throws(() => validateProcedureValues(parameters, { '@Items': [{ id: 1, unknown: 2 }] }));
  assert.throws(() => validateProcedureValues([{ name: '@ID', type: 'int' }], { '@ID': '1.5' }));
});
test('parameter values are validated without concatenating them into SQL', () => {
  const parameters = [{ name: '@StartDate', type: 'datetime' }, { name: '@Count', type: 'int' }, { name: '@Name', type: 'nvarchar' }];
  assert.deepEqual(validateProcedureValues(parameters, { '@StartDate': '2024-01-01', '@Count': '12', '@Name': "x'; DELETE FROM x;--" }), ['2024-01-01', '12', "x'; DELETE FROM x;--"]);
  assert.throws(() => validateProcedureValues(parameters, { '@StartDate': 'nonsense' }));
  assert.throws(() => validateProcedureValues(parameters, { '@StartDate': '2024-01-01', '@Count': '1;drop', '@Name': '' }));
  assert.throws(() => validateProcedureValues([], { injected: 1 }));
  assert.deepEqual(validateProcedureValues([{ name: '@Date', type: 'date' }], { '@Date': null }), [null]);
});
