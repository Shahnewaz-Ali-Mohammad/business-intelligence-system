import test from 'node:test';
import assert from 'node:assert/strict';
import {extractWinningToolOutputs, hasVerifiedWorkspaceResult} from './agent.mjs';
test('workspace record and aggregate evidence proceeds to the dedicated insight writer without a second narrative critique', () => {
  const state = { toolset: {}, structured: { intent: 'answer' }, toolOutputs: [] };
  for (const result of [{ mode: 'rows', rows: [] }, { mode: 'aggregate', summary: { population: 10 } }]) {
    assert.equal(hasVerifiedWorkspaceResult({ ...state, toolOutputs: [JSON.stringify(result)] }), true);
  }
  for (const result of [{ mode: 'aggregate' }, { field: 'Status', values: ['Open'] }, { error: 'Query failed' }]) {
    assert.equal(hasVerifiedWorkspaceResult({ ...state, toolOutputs: [JSON.stringify(result)] }), false);
  }
  assert.equal(hasVerifiedWorkspaceResult({ ...state, toolset: null, toolOutputs: [JSON.stringify({ mode: 'rows', rows: [] })] }), false);
  assert.equal(hasVerifiedWorkspaceResult({ ...state, structured: { intent: 'ask_clarification' }, toolOutputs: [JSON.stringify({ mode: 'rows', rows: [] })] }), false);
});
test('different workspace queries retain both results while identical retries replace stale evidence',()=>{
 const name='customer_summary_db_123';
 const calls=[{id:'a',name,args:{query:'first period'}},{id:'b',name,args:{query:'second period'}},{id:'c',name,args:{query:'first period'}}];
 const tool=(id,content)=>({getType:()=> 'tool',tool_call_id:id,content});
 assert.deepEqual(extractWinningToolOutputs([{tool_calls:calls},tool('a','old'),tool('b','second'),tool('c','first corrected')]),['first corrected','second']);
});

test('structured MCP blocks preserve record evidence even after a large statistics payload',()=>{
 const name='customer_details_db_123';
 const data={summary:{population:1,numeric:Array.from({length:100},(_,i)=>({title:'measure'+i,statistics:{long:'x'.repeat(100)}}))},rows:[{CustomerID:'100001',Name:'Example'}],rowsAreComplete:true};
 const result=extractWinningToolOutputs([{tool_calls:[{id:'one',name,args:{query:{}}}]},{getType:()=> 'tool',tool_call_id:'one',content:[{type:'text',text:JSON.stringify(data)}]}]);
 const evidence=JSON.parse(result[0]);assert.deepEqual(evidence.rows,data.rows);assert.equal(evidence.summary.population,1);assert.equal(evidence.summary.numeric.length,8);
});
