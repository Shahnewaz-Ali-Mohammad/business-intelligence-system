import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {scenarioTemplates} from './scenario-templates.mjs';
import {createToolServer,mcpToolName} from './mcp.mjs';
import {savedReportTools} from './saved-report-tools.mjs';
import {compileTool} from './model.mjs';
const catalog={objects:[{id:'c',schema:'dbo',name:'CustomerMaster',kind:'table',columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:true},{name:'Name',dataType:'varchar'}]}],relationships:[]};
test('discovery executes a persisted report through MCP with values only and rejects query rebuilding',async()=>{
 const registry=scenarioTemplates(catalog).map((definition,i)=>({id:String(i),sourceId:'s',status:'approved',definition}));
 let calls=0;
 const server=createToolServer(registry,async(t,args)=>{const compiled=compileTool(t.definition,catalog,'sqlserver',args);calls++;assert.deepEqual(compiled.values,['100001']);return {mode:'rows',rows:[{CustomerID:'100001'}]};},catalog);
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);const[find,run]=savedReportTools(client,registry);
 const index=JSON.parse(await find.invoke({request:'customer ID 100001 details'}));assert.ok(index.reports.length<=6);
 const lookup=registry.find(t=>t.definition.filters[0]?.operator==='eq');const name=mcpToolName('s',lookup.definition.name);
 assert.ok(index.reports.some(r=>r.report_name===name));
 const result=JSON.parse(await run.invoke({report_name:name,parameters:{filter_value:100001}}));assert.equal(result.rows[0].CustomerID,'100001');assert.equal(calls,1);
 await assert.rejects(run.invoke({report_name:name,parameters:{query:'SELECT *'}}),/parameter values only/);assert.equal(calls,1);
 await assert.rejects(run.invoke({report_name:'unknown',parameters:{}}),/approved saved report/);
 }finally{await client.close();await server.close();}
});
