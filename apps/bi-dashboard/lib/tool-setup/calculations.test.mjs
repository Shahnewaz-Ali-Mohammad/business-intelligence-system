import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageTools} from './coverage.mjs';
import {compileTool} from './model.mjs';
const column=(name,dataType,pk=false)=>({name,dataType,isPrimaryKey:pk});
const catalog={objects:[
 {id:'bills',schema:'dbo',name:'Bills',kind:'table',columns:[column('ID','int',true),column('Status','varchar'),column('Debit','decimal'),column('Credit','decimal'),column('Date','datetime')]}
],relationships:[]};
const tools=coverageTools(catalog),rows=tools.find(t=>t.mode==='rows'),agg=tools.find(t=>t.mode==='aggregate');
const compile=(tool,plan,dialect)=>compileTool(tool,catalog,dialect,{query:JSON.stringify(plan)});
for(const dialect of ['mysql','postgres','sqlserver']){
 test(`${dialect}: calculated record columns`,()=>{
  const r=compile(rows,{columns:['bills:ID','bills:Debit','bills:Credit'],derived:[{alias:'balance',operation:'subtract',inputs:['bills:Debit','bills:Credit']}],sort:[{field:'balance',direction:'desc'}]},dialect);
  assert.match(r.sql,/ - /);assert.deepEqual(r.outputFields.at(-1),'balance');assert.match(r.sql,/ORDER BY .c3. DESC|ORDER BY "c3" DESC|ORDER BY \[c3\] DESC/);
 });
 test(`${dialect}: share of total, growth, running total, moving average`,()=>{
  const r=compile(agg,{dateGroups:[{field:'bills:Date',grain:'month'}],metrics:[{field:'bills:Debit',operation:'sum',alias:'billed'}],derived:[
   {alias:'share',operation:'percent_of_total',inputs:['billed']},{alias:'growth',operation:'percent_change',inputs:['billed']},
   {alias:'cumulative',operation:'running_total',inputs:['billed']},{alias:'avg3',operation:'moving_average',inputs:['billed'],window:3}]},dialect);
  assert.match(r.sql,/OVER \(\)/);assert.match(r.sql,/LAG\(/);assert.match(r.sql,/ROWS UNBOUNDED PRECEDING/);assert.match(r.sql,/2 PRECEDING/);
  assert.deepEqual(r.outputFields,['bills:Date','billed','share','growth','cumulative','avg3']);
 });
 test(`${dialect}: conditional metrics and having keep values in order`,()=>{
  const r=compile(agg,{groupBy:['bills:Status'],where:{field:'bills:Date',operator:'gte',value:'2026-01-01'},metrics:[{field:null,operation:'count',alias:'all_bills'},{field:'bills:Debit',operation:'sum',alias:'paid',where:{field:'bills:Credit',operator:'gt',value:0}}],having:[{field:'all_bills',operator:'gt',value:5}],derived:[{alias:'paid_pct',operation:'percent_of',inputs:['paid','all_bills']}]},dialect);
  assert.match(r.sql,/CASE WHEN/);assert.match(r.sql,/HAVING/);
  if(dialect==='mysql'){assert.doesNotMatch(r.sql,/\?\{/);const vals=r.values.map(String);assert.equal(vals[0],'0');assert.equal(vals.at(-1),'5');}
 });
 test(`${dialect}: invalid calculations are rejected`,()=>{
  assert.throws(()=>compile(agg,{metrics:[{field:null,operation:'count',alias:'n'}],derived:[{alias:'x',operation:'running_total',inputs:['n']}]},dialect),/grouping/);
  assert.throws(()=>compile(rows,{columns:['bills:Status'],derived:[{alias:'x',operation:'add',inputs:['bills:Status','bills:Status']}]},dialect),/numeric/);
 });
}
