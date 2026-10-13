import test from 'node:test';
import assert from 'node:assert/strict';
import {withOutputRecovery} from './generation-output.mjs';
test('SDK truncation retries just the affected group with increased output space',async()=>{
 const budgets=[],progress=[];const result=await withOutputRecovery(async budget=>{budgets.push(budget);if(budget===32768)throw new Error('Could not parse response content as the length limit was reached');return {tools:['complete']};},message=>progress.push(message));
 assert.deepEqual(budgets,[32768,65536]);assert.deepEqual(result.tools,['complete']);assert.equal(progress.length,1);
});
test('non-length failures are not blindly retried',async()=>{let calls=0;await assert.rejects(withOutputRecovery(async()=>{calls++;throw new Error('Authentication failed');}),/Authentication/);assert.equal(calls,1);});
test('repeated truncation ends with a recoverable failure instead of looping forever',async()=>{let calls=0;await assert.rejects(withOutputRecovery(async()=>{calls++;throw new Error('length limit was reached');}),/length limit/);assert.equal(calls,2);});
