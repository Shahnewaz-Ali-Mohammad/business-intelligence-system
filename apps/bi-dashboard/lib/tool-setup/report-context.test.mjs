import test from 'node:test';
import assert from 'node:assert/strict';
import {reportContext} from './report-context.mjs';
test('follow-ups retain prior filters and map explicitly requested IDs without exposing names',()=>{
 const report={toolName:'customers',mode:'rows',query:JSON.stringify({columns:['customers:ID'],where:{field:'customers:City',operator:'eq',value:'Dhaka'}}),rows:[{'customers:ID':100009,'customers:Name':'Private name','customers:Phone':'Private phone'}]};
 const context=reportContext(report,'show all details for 100009');
 assert.deepEqual(context.identifierMatches,[{field:'customers:ID',value:'100009'}]);assert.equal(context.query.where.value,'Dhaka');assert.doesNotMatch(JSON.stringify(context),/Private name|Private phone/);
});
test('ambiguous matching ID fields are preserved for clarification instead of guessed',()=>{
 const context=reportContext({query:'{}',rows:[{'customers:ID':100009,'customers:LoginID':100009}]},'details for 100009');assert.equal(context.identifierMatches.length,2);
});
