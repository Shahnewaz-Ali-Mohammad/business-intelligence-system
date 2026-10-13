import test from 'node:test';
import assert from 'node:assert/strict';
import {extractWinningToolOutputs} from './agent.mjs';
test('different workspace queries retain both results while identical retries replace stale evidence',()=>{
 const name='customer_summary_db_123';
 const calls=[{id:'a',name,args:{query:'first period'}},{id:'b',name,args:{query:'second period'}},{id:'c',name,args:{query:'first period'}}];
 const tool=(id,content)=>({getType:()=> 'tool',tool_call_id:id,content});
 assert.deepEqual(extractWinningToolOutputs([{tool_calls:calls},tool('a','old'),tool('b','second'),tool('c','first corrected')]),['first corrected','second']);
});
