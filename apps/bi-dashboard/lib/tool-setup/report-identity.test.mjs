import test from 'node:test';
import assert from 'node:assert/strict';
import {reportFingerprint,reportCovers,uniqueReports} from './report-identity.mjs';
const base={name:'old_lookup',description:'Original customer lookup.',base:'dbo.CustomerMaster',joins:[],mode:'rows',columns:['c:ID','c:Name','c:City'],groupBy:[],metrics:[],filters:[{field:'c:ID',operator:'eq',parameter:'filter_value',required:true}],template:{projection:true,limit:true,sortFields:['c:ID','c:Name'],sort:[],dateGroups:[]}};
test('renamed inputs, reordered fields and property order do not duplicate the same report',()=>{
 const changed={...base,name:'new_lookup',description:'Different wording.',columns:[...base.columns].reverse(),filters:[{required:true,parameter:'customer_idostring',operator:'eq',field:'c:ID'}]};
 assert.equal(reportFingerprint(base),reportFingerprint(changed));
});
test('an existing projected report covers a narrower new detail report',()=>{
 const subset={...base,columns:['c:Name','c:ID'],template:{...base.template,sortFields:['c:Name']}};
 assert.equal(reportCovers(base,subset),true);assert.equal(reportCovers(subset,base),false);
 assert.equal(reportCovers({...base,template:undefined},subset),false);
 const unique=uniqueReports([{definition:subset,id:'new'},{definition:base,id:'original'}]);assert.equal(unique.length,1);assert.equal(unique[0].id,'original');
});
test('different filters, joins or stored default ranking remain different reports',()=>{
 assert.notEqual(reportFingerprint(base),reportFingerprint({...base,filters:[{...base.filters[0],operator:'in'}]}));
 assert.notEqual(reportFingerprint(base),reportFingerprint({...base,joins:['other']}));
 assert.notEqual(reportFingerprint(base),reportFingerprint({...base,template:{...base.template,sort:[{field:'c:ID',direction:'desc'}]}}));
});
test('shared versus independent parameter bindings preserve different meanings',()=>{
 const filters=[{field:'c:ID',operator:'eq',parameter:'a',required:true},{field:'c:Name',operator:'eq',parameter:'a',required:true}];
 assert.notEqual(reportFingerprint({...base,filters}),reportFingerprint({...base,filters:[filters[0],{...filters[1],parameter:'b'}]}));
});

test('renaming an aggregate output alias does not create another calculation',()=>{
 const aggregate={...base,mode:'aggregate',columns:[],metrics:[{field:null,operation:'count',alias:'record_count'}],template:{...base.template,projection:false,sort:[{field:'record_count',direction:'desc'}]}};
 const renamed={...aggregate,metrics:[{field:null,operation:'count',alias:'number_of_records'}],template:{...aggregate.template,sort:[{field:'number_of_records',direction:'desc'}]}};
 assert.equal(reportFingerprint(aggregate),reportFingerprint(renamed));
});
