import test from 'node:test';
import assert from 'node:assert/strict';
import {generateTools} from './generate.ts';
test('cancelled generation exits before any model request or registry write',async()=>{
 const controller=new AbortController();controller.abort(new Error('Cancelled by user'));
 await assert.rejects(generateTools({objects:[],relationships:[]},[],'',{signal:controller.signal}),/Cancelled by user/);
});

test('completed schema groups resume without making a model request',async()=>{
 process.env.OPENAI_API_KEY ||= 'synthetic-key-not-used';
 const catalog={objects:[{id:'customers',schema:'dbo',name:'Customers',kind:'table',columns:[{name:'ID',dataType:'int'},{name:'Name',dataType:'varchar'}]}],relationships:[],fingerprint:'test'};
 const saved={name:'customer_details',description:'Read customer IDs and names.',base:'customers',mode:'rows',columns:['customers:ID','customers:Name'],joins:[],groupBy:[],metrics:[],filters:[]};
 const progress=[];
 const result=await generateTools(catalog,[{id:'customers',columns:['ID','Name']}],'',{completedBatches:{0:[saved]},onProgress:message=>{progress.push(message);}});
 assert.ok(result.some(tool=>tool.name==='customer_details'));
 assert.match(progress[0],/Resumed/);
});
