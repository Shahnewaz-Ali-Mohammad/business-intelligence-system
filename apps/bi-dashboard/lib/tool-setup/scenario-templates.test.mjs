import test from 'node:test';
import assert from 'node:assert/strict';
import {scenarioTemplates,compileTemplateCheck} from './scenario-templates.mjs';
import {compileTool} from './model.mjs';
import {scenarioCandidates,selectedScope} from './scenario-selection.mjs';
const catalog={objects:[{id:'customers',schema:'dbo',name:'CustomerMaster',kind:'table',columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:true},{name:'City',dataType:'varchar'},{name:'Balance',dataType:'decimal'},{name:'Created',dataType:'datetime'},{name:'Password',dataType:'varchar'}]},{id:'bills',schema:'dbo',name:'BillingMaster',kind:'table',columns:[{name:'BillID',dataType:'int',isPrimaryKey:true},{name:'CustomerID',dataType:'varchar'},{name:'Amount',dataType:'decimal'}]}],relationships:[{id:'fk',from:'bills',to:'customers',targetUnique:true,columns:[{from:'CustomerID',to:'CustomerID'}]}]};
const templates=scenarioTemplates(catalog);
test('initial generation covers schema-based scenario families with stable stored plans and no generic capabilities',()=>{
 assert.deepEqual(scenarioTemplates(catalog),templates);assert.equal(new Set(templates.map(t=>t.name)).size,templates.length);
 assert.ok(templates.every(t=>t.template&&!t.capabilities));assert.ok(templates.some(t=>t.filters[0]?.operator==='in'));
 assert.ok(templates.some(t=>t.groupBy.length));assert.ok(templates.some(t=>t.template.dateGroups.length));assert.ok(templates.some(t=>t.joins.length));
 assert.ok(templates.every(t=>!t.columns.some(f=>f.endsWith(':Password'))));
});
for(const dialect of ['mysql','postgres','sqlserver'])test(`${dialect}: saved templates preflight as zero-row SELECTs; lookup values never alter the stored query`,()=>{
 for(const definition of templates){const check=compileTemplateCheck(definition,catalog,dialect);assert.match(check.sql,/^SELECT \* FROM/);assert.match(check.sql,/WHERE 1=0$/);}
 const lookup=templates.find(t=>t.base==='customers'&&t.filters[0]?.field==='customers:CustomerID'&&t.filters[0].operator==='eq');
 const a=compileTool(lookup,catalog,dialect,{filter_value:100001,report_columns:['customers:CustomerID'],report_limit:100});
 const b=compileTool(lookup,catalog,dialect,{filter_value:'CID-11560',report_columns:['customers:CustomerID'],report_limit:100});
 assert.equal(a.sql,b.sql);assert.deepEqual(a.values,['100001']);assert.deepEqual(b.values,['CID-11560']);
 assert.throws(()=>compileTool(lookup,catalog,dialect,{query:JSON.stringify({joins:['fk'],values:{filter_value:100001}})}));
 assert.throws(()=>compileTool(lookup,catalog,dialect,{filter_value:100001,report_columns:['bills:Amount']}),/output fields/);
 assert.throws(()=>compileTool(lookup,catalog,dialect,{filter_value:100001,report_sort_field:'bills:Amount'}),/Ordering field/);
});
test('saved report selection excludes generic query builders once templates are approved',()=>{
 const fixed=templates.map((definition,i)=>({id:String(i),sourceId:'s',definition}));const generic={id:'generic',sourceId:'s',definition:{...templates[0],template:undefined,capabilities:{fields:['customers:CustomerID'],joins:[]}}};
 const chosen=scenarioCandidates('show customer ID 100001 details',[],[generic,...fixed]);assert.ok(chosen.length<=24);assert.ok(chosen.every(t=>!t.definition.capabilities));
 assert.ok(chosen.some(t=>t.definition.filters[0]?.field==='customers:CustomerID'));
 const scope=selectedScope(catalog,[fixed[0]],'s');assert.equal(scope.length,1);assert.equal(scope[0].id,'customers');assert.ok(!scope[0].columns.includes('Password'));
});

test('targeted generation returns only missing fixed templates and preserves selected scope',async()=>{
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY=prior||'test-key';
 try{const{generateTools}=await import('./generate.ts');
 const selected=catalog.objects.map(o=>({id:o.id,columns:o.columns.filter(c=>c.name!=='Password').map(c=>c.name)}));
 const seed={...templates.find(t=>t.base==='customers'&&t.filters[0]?.operator==='eq')};delete seed.template;
 const generated=await generateTools(catalog,selected,'Missing customer ID detail report',{missingOnly:true,completedBatches:{0:[seed]}});
 assert.equal(generated.length,1);assert.ok(generated[0].template);assert.equal(generated[0].capabilities,undefined);assert.deepEqual(generated[0].filters,seed.filters);
 }finally{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;}
});

test('explicit customer ID lookups never substitute another identifier such as SNID',()=>{
 const mock=[{definition:{...templates[0],filters:[{field:'customers:SNID'}]}},{definition:{...templates[0],filters:[{field:'customers:CustomerID'}]}}];
 const found=scenarioCandidates('details for customer id 100001',[],mock);assert.equal(found.length,1);assert.equal(found[0].definition.filters[0].field,'customers:CustomerID');
});
