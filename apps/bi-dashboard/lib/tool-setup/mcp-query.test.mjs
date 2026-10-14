import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {loadMcpTools} from '@langchain/mcp-adapters';
import {createToolServer} from './mcp.mjs';
import {coverageTools} from './coverage.mjs';
import {compileTool} from './model.mjs';
const catalog={objects:[{id:'c',schema:'dbo',name:'Customers',kind:'table',columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:true},{name:'Name',dataType:'varchar'}]}],relationships:[]};
const tool={id:'one',sourceId:'db',status:'approved',definition:coverageTools(catalog)[0]};
test('real LangChain MCP adapter accepts structured filters, rejects parameter-name confusion, and serializes exact query',async()=>{
 let calls=0;
 const server=createToolServer([tool],async(t,args)=>{const result=compileTool(t.definition,catalog,'sqlserver',args);calls++;assert.deepEqual(result.values,['100001']);assert.equal(JSON.parse(args.query).limit,100);return {rows:[],hasMore:false};},catalog);
 const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);const [loaded]=await loadMcpTools('test',client);
  await loaded.invoke({query:{allColumns:true,limit:100,where:{field:'c:CustomerID',operator:'eq',value:100001}}});assert.equal(calls,1);
  await assert.rejects(loaded.invoke({query:{where:{field:'c:CustomerID',operator:'eq',parameter:'100001'}}}));assert.equal(calls,1);
 }finally{await client.close();await server.close();}
});
test('a fresh MCP connection reflects newly approved and revoked tools',async()=>{
 async function names(tools){const server=createToolServer(tools,async()=>({}));const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();try{await server.connect(b);await client.connect(a);return (await client.listTools()).tools.map(t=>t.name);}finally{await client.close();await server.close();}}
 assert.equal((await names([{...tool,status:'draft'}])).length,0);
 assert.equal((await names([tool])).length,1);
 assert.equal((await names([{...tool,status:'draft'}])).length,0);
});
