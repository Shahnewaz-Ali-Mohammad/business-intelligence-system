import test from 'node:test';
import assert from 'node:assert/strict';
import { updateApprovals } from './approval.mjs';
const tool = {id:'one',version:1,definition:{name:'one'},catalog_fingerprint:'schema'};
function database(failAt = 0) {
 const events=[];
 return { events, async beginTransaction(){events.push('begin');}, async commit(){events.push('commit');}, async rollback(){events.push('rollback');}, async execute(sql, values){ events.push({sql,values}); return [{affectedRows: events.filter(e=>typeof e==='object').length === failAt ? 0 : 1}]; } };
}
test('untested draft can be approved without running a query or checking test hashes',async()=>{
 const db=database(); assert.deepEqual(await updateApprovals(db,[tool],true),{updated:1,approved:true});
 assert.equal(db.events[1].values[0],'approved'); assert.doesNotMatch(db.events[1].sql,/tested_hash|EXEC |SELECT /); assert.equal(db.events.at(-1),'commit');
});
test('revoke clears approval and sets draft even with no test history',async()=>{
 const db=database(); await updateApprovals(db,[tool],false);
 assert.equal(db.events[1].values[0],'draft'); assert.match(db.events[1].sql,/NULL/); assert.equal(db.events.at(-1),'commit');
});
test('approve all commits all registry changes together',async()=>{
 const db=database(); assert.equal((await updateApprovals(db,[tool,{...tool,id:'two'}],true)).updated,2);
 assert.equal(db.events.filter(e=>typeof e==='object').length,2); assert.equal(db.events.at(-1),'commit');
});
test('concurrent edit rolls back bulk approval',async()=>{
 const db=database(2); await assert.rejects(updateApprovals(db,[tool,{...tool,id:'two'}],true),/Tool changed/);
 assert.equal(db.events.at(-1),'rollback'); assert.ok(!db.events.includes('commit'));
});
