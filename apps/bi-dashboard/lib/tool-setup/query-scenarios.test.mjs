import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageTools} from './coverage.mjs';
import {compileTool} from './model.mjs';
const column=(name,dataType,pk=false)=>({name,dataType,isPrimaryKey:pk});
const catalog={objects:[
 {id:'customers',schema:'dbo',name:'Customers',kind:'table',columns:[column('ID','int',true),column('Name','varchar'),column('City','varchar'),column('Balance','decimal')]},
 {id:'bills',schema:'dbo',name:'Bills',kind:'table',columns:[column('ID','int',true),column('CustomerID','int'),column('Amount','decimal'),column('Date','datetime')]},
 {id:'payments',schema:'dbo',name:'Payments',kind:'table',columns:[column('ID','int',true),column('CustomerID','int'),column('Amount','decimal')]}
],relationships:[{id:'bill_customer',from:'bills',to:'customers',targetUnique:true,columns:[{from:'CustomerID',to:'ID'}]},{id:'payment_customer',from:'payments',to:'customers',targetUnique:true,columns:[{from:'CustomerID',to:'ID'}]}]};
const tools=coverageTools(catalog),rows=tools.find(t=>t.base==='customers'&&t.mode==='rows'),agg=tools.find(t=>t.base==='customers'&&t.mode==='aggregate');
const compile=(tool,plan,dialect)=>compileTool(tool,catalog,dialect,{query:JSON.stringify(plan)});
for(const dialect of ['mysql','postgres','sqlserver']){
 test(`${dialect}: selected fields, nested AND/OR, IDs and sorting compose safely`,()=>{
  const result=compile(rows,{columns:['customers:ID','customers:Name'],where:{and:[{field:'customers:ID',operator:'in',value:[100009,100010]},{or:[{field:'customers:City',operator:'eq',value:'Dhaka'},{field:'customers:Name',operator:'contains',value:"x' OR 1=1 --"}]}]},sort:[{field:'customers:Name',direction:'desc'}]},dialect);
  assert.ok(result.sql.includes(' IN ('));assert.match(result.sql,/ OR /);assert.match(result.sql,/ORDER BY.*c1.*DESC/);assert.doesNotMatch(result.sql,/OR 1=1/);assert.equal(result.values.length,4);
 });
 test(`${dialect}: parent to child joins are inferred and child sums preserve grain`,()=>{
  const result=compile(agg,{groupBy:['customers:City'],metrics:[{field:'bills:Amount',operation:'sum',alias:'billed'}]},dialect);
  assert.deepEqual(result.joinIds,['bill_customer']);assert.match(result.sql,/LEFT JOIN.*Bills/);assert.match(result.sql,/SUM/);
 });
 test(`${dialect}: unsafe parent and sibling totals are rejected`,()=>{
  assert.throws(()=>compile(agg,{joins:['bill_customer'],metrics:[{field:'customers:Balance',operation:'sum',alias:'balance'}]},dialect),/multiply/);
  assert.throws(()=>compile(agg,{joins:['bill_customer','payment_customer'],metrics:[{field:'bills:Amount',operation:'sum',alias:'billed'}]},dialect),/multiply/);
 });
 test(`${dialect}: distinct customer counts work across child joins`,()=>{
  const result=compile(agg,{joins:['bill_customer'],metrics:[{field:'customers:ID',operation:'count_distinct',alias:'customers'}]},dialect);assert.match(result.sql,/COUNT(?:_BIG)?\(DISTINCT/);
 });
 test(`${dialect}: date grouping and metric sorting compose with range filters`,()=>{
  const tool=tools.find(t=>t.base==='bills'&&t.mode==='aggregate');
  const result=compile(tool,{groupBy:['bills:Date'],dateGroups:[{field:'bills:Date',grain:'month'}],metrics:[{field:'bills:Amount',operation:'sum',alias:'billed'}],where:{field:'bills:Date',operator:'between',value:['2026-01-01','2026-12-31']},sort:[{field:'billed',direction:'desc'}]},dialect);
  assert.match(result.sql,/GROUP BY/);assert.match(result.sql,/BETWEEN/);assert.equal(result.values.length,2);
 });
 test(`${dialect}: unique projected rows use a valid dialect-specific SELECT`,()=>{
  const result=compile(rows,{columns:['customers:City'],distinct:true},dialect);assert.match(result.sql,/SELECT DISTINCT/);assert.doesNotMatch(result.populationSql,/TOP/);
 });
 test(`${dialect}: unapproved fields and ambiguous joins are not guessed`,()=>{
  assert.throws(()=>compile(rows,{where:{field:'invented:Secret',operator:'eq',value:1}},dialect),/approved/);
  const duplicate={...catalog,relationships:[...catalog.relationships,{...catalog.relationships[0],id:'bill_creator'}]};
  const alternative=coverageTools(duplicate).find(t=>t.base==='customers'&&t.mode==='rows');
  assert.throws(()=>compileTool(alternative,duplicate,dialect,{query:JSON.stringify({columns:['bills:ID']})}),/Multiple relationship/);
 });
}
test('fixed tools can bind ID arrays without changing their report definition',()=>{
 const fixed={...rows,capabilities:undefined,filters:[{field:'customers:ID',operator:'in',parameter:'ids',required:true}]};
 const result=compile(fixed,{values:{ids:[100009,100010]}},'mysql');assert.deepEqual(result.values,[100009,100010]);
});
test('repeated parent measures are excluded from row insight totals',()=>{
 const result=compile(rows,{columns:['customers:Balance','bills:Amount']},'mysql');assert.deepEqual(result.unsafeAggregateFields,['customers:Balance']);
});

test('SQL Server does not repeat an explicitly sorted key as a tie breaker',()=>{
 const result=compile(rows,{columns:['customers:ID'],sort:[{field:'customers:ID',direction:'desc'}]},'sqlserver');
 assert.match(result.sql,/ORDER BY \[c0\] DESC(?:$| OFFSET)/);
});
test('record views without declared keys retain deterministic comparable ordering on every page',()=>{
 const view={...catalog,objects:catalog.objects.map(o=>({...o,columns:o.columns.map(c=>({...c,isPrimaryKey:false}))}))};
 const tool=coverageTools(view).find(t=>t.base==='customers'&&t.mode==='rows');
 const result=compileTool(tool,view,'sqlserver',{query:JSON.stringify({columns:['customers:ID','customers:Name'],sort:[{field:'customers:ID',direction:'desc'}]})},10,10);
 assert.match(result.sql,/ORDER BY/);assert.match(result.sql,/OFFSET 10 ROWS/);
});

for(const dialect of ['mysql','postgres','sqlserver']) {
 test(`${dialect}: numeric-looking text IDs bind as strings for nested, flat, list and fixed filters`,()=>{
  const textCatalog={objects:[{id:'c',schema:'dbo',name:'Customers',kind:'table',columns:[column('CustomerID','varchar',true),column('Amount','decimal')]}],relationships:[]};
  const textTool=coverageTools(textCatalog)[0];
  const run=plan=>compileTool(textTool,textCatalog,dialect,{query:JSON.stringify(plan)});
  assert.deepEqual(run({where:{field:'c:CustomerID',operator:'eq',value:100001}}).values,['100001']);
  assert.deepEqual(run({where:{field:'c:CustomerID',operator:'in',value:[100001,'CID-11560']}}).values,['100001','CID-11560']);
  const filter={field:'c:CustomerID',operator:'eq',parameter:'customer_id',required:true};
  assert.deepEqual(run({filters:[filter],values:{customer_id:100001}}).values,['100001']);
  const fixed={...textTool,capabilities:undefined,filters:[filter]};
  assert.deepEqual(compileTool(fixed,textCatalog,dialect,{customer_id:100001}).values,['100001']);
  assert.deepEqual(run({where:{field:'c:Amount',operator:'eq',value:7}}).values,[7]);
 });
 test(`${dialect}: requested first 100 caps report population, pages, and export batches`,()=>{
  const parameters={query:JSON.stringify({limit:100,columns:['customers:ID'],sort:[{field:'customers:ID',direction:'desc'}]})};
  const first=compileTool(rows,catalog,dialect,parameters,40,0);
  assert.equal(first.limit,40);assert.match(first.populationSql,/TOP \(100\)|LIMIT 100/);assert.match(first.populationSql,/ORDER BY/);
  const last=compileTool(rows,catalog,dialect,parameters,40,80);assert.equal(last.limit,20);assert.match(last.sql,/FETCH NEXT 20|LIMIT 20/);
  const beyond=compileTool(rows,catalog,dialect,parameters,40,100);assert.equal(beyond.limit,0);assert.match(beyond.sql,/WHERE 1=0/);
  const exported=compileTool(rows,catalog,dialect,parameters,5000,0,{maxLimit:5000});assert.equal(exported.limit,100);assert.match(exported.sql,/TOP \(100\)|LIMIT 100/);
 });
}
