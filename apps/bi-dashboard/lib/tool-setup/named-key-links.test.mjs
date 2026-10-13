import test from 'node:test';
import assert from 'node:assert/strict';
import {namedKeyLinks} from './named-key-links.mjs';
const parent={id:'customers',name:'CustomerMaster',columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:true}]};
const child={id:'bills',name:'BillingMaster',columns:[{name:'CustomerID',dataType:'nvarchar'}]};
test('matching entity-specific IDs and declared unique targets produce a labeled relationship',()=>{
 const catalog={objects:[parent,child],relationships:[],fingerprint:'physical-schema'};
 const enriched=namedKeyLinks(catalog);assert.equal(enriched.relationships.length,1);assert.equal(enriched.relationships[0].kind,'inferred_named_primary_key');assert.equal(enriched.fingerprint,'physical-schema');assert.equal(namedKeyLinks(enriched).relationships.length,1);
});
test('generic IDs, nonunique targets and ambiguous target tables are not inferred',()=>{
 assert.equal(namedKeyLinks({objects:[{...parent,columns:[{name:'CustomerID',dataType:'varchar',isPrimaryKey:false}]},child],relationships:[]}).relationships.length,0);
 assert.equal(namedKeyLinks({objects:[parent,{...parent,id:'other-customers'},child],relationships:[]}).relationships.length,0);
 assert.equal(namedKeyLinks({objects:[{id:'a',name:'Anything',columns:[{name:'ID',dataType:'int',isPrimaryKey:true}]},{id:'b',name:'Else',columns:[{name:'ID',dataType:'int'}]}],relationships:[]}).relationships.length,0);
});

test('selection cannot turn an ambiguous full catalog into an inferred relationship',()=>{
 const full=namedKeyLinks({objects:[parent,{...parent,id:'other-customers'},child],relationships:[]});
 assert.equal(namedKeyLinks({...full,objects:[parent,child]}).relationships.length,0);
});
