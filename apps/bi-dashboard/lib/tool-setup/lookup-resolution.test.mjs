import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSavedLookup,missingReportDecision} from './lookup-resolution.mjs';
const definition={name:'saved_customer',base:'dbo.CustomerMaster',mode:'rows',joins:[],columns:['dbo.CustomerMaster:CustomerID','dbo.CustomerMaster:Name'],groupBy:[],metrics:[],filters:[{field:'dbo.CustomerMaster:CustomerID',operator:'eq',parameter:'filter_value',required:true}],template:{projection:true}};
const registry=[{id:'original',sourceId:'s',status:'approved',definition},{id:'overlap',sourceId:'s',status:'approved',definition:{...definition,name:'new_customer',columns:definition.columns.slice(0,1),filters:[{...definition.filters[0],parameter:'customer_idostring'}]}},{id:'billing',status:'approved',definition:{...definition,name:'bill_customer',base:'dbo.BillingMaster'}}];
const question='100001 show me all the details for this customer id';
test('the exact failed question resolves the original full customer lookup and values only',()=>{
 const result=resolveSavedLookup(question,registry);assert.equal(result.chosen.id,'original');assert.deepEqual(result.parameters,{filter_value:'100001'});
});
test('compound filters and multiple IDs are not silently dropped',()=>{
 assert.equal(resolveSavedLookup('show customer id 100001 and 100002 details',registry),null);
 assert.equal(resolveSavedLookup('show customer id 100001 billing for last month',registry),null);
});
test('zero-result executions and execution failures cannot become missing scenarios',()=>{
 assert.equal(missingReportDecision({message:question,registry,completed:1,gap:'No details available; not found'}).kind,'executed');
 assert.equal(missingReportDecision({message:question,registry,failed:true}).kind,'execution_error');
 assert.equal(missingReportDecision({message:question,registry,gap:'Missing lookup'}).kind,'existing');
});
test('existing unapproved tools direct to approval rather than generation',()=>{
 const result=missingReportDecision({message:question,registry:registry.map(t=>({...t,status:'draft'}))});assert.equal(result.kind,'needs_approval');
});
test('an absence-of-data assertion is not accepted as a capability description',()=>{
 assert.equal(missingReportDecision({message:'show unicorn records',registry:[],gap:'No records found; it does not exist'}).kind,'not_a_capability_gap');
 assert.equal(missingReportDecision({message:'show monthly invoice totals',registry:[],gap:'Monthly invoice totals grouped by customer are unsupported'}).kind,'missing');
});
