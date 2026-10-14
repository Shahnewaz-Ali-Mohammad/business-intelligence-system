import test from 'node:test';
import assert from 'node:assert/strict';
import {readCatalog} from './catalog.mjs';
import {validateTool} from './model.mjs';
import {updateApprovals} from './approval.mjs';
const saved={fingerprint:'physical-schema',objects:[{id:'c',schema:'dbo',name:'CustomerMaster',kind:'table',columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:true}]},{id:'b',schema:'dbo',name:'BillingMaster',kind:'table',columns:[{name:'CustomerID',dataType:'nvarchar'}]}],relationships:[]};
test('saved physical catalog exposes the same inferred joins for generation and approval',async()=>{
 const catalog=readCatalog(JSON.stringify(saved));
 assert.equal(catalog.fingerprint,saved.fingerprint);assert.equal(catalog.relationships.length,1);assert.deepEqual(readCatalog(catalog),catalog);
 const definition={name:'customer_billing',description:'Read approved customer and billing details.',base:'b',joins:[catalog.relationships[0].id],mode:'rows',columns:['b:CustomerID','c:CustomerID'],groupBy:[],metrics:[],filters:[]};
 assert.throws(()=>validateTool(definition,saved),/available foreign key/);
 validateTool(definition,catalog);
 let committed=false;let updates=0;
 const db={async beginTransaction(){},async execute(){updates++;return [{affectedRows:1}];},async commit(){committed=true;},async rollback(){throw Error('Unexpected rollback');}};
 await updateApprovals(db,[{id:'one',version:1,definition,catalog_fingerprint:catalog.fingerprint}],true);
 assert.equal(updates,1);assert.equal(committed,true);
});
test('catalog enrichment does not accept unknown relationship IDs',()=>{
 const catalog=readCatalog(saved);
 assert.throws(()=>validateTool({name:'bad_relationship',description:'Unknown relationship must remain blocked.',base:'b',joins:['unknown'],mode:'rows',columns:['b:CustomerID'],groupBy:[],metrics:[],filters:[]},catalog),/available foreign key/);
});
