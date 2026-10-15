import crypto from 'node:crypto';
const normal=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
const type=value=>value.toLowerCase().replace(/^n(var)?char/,'$1char').replace(/\(.*/, '').trim();
export function namedKeyLinks(catalog){
 if(catalog.namedKeyLinksVersion===4)return catalog;
 const targets=new Map();
 for(const object of catalog.objects){
  const keys=object.columns.filter(c=>c.isPrimaryKey&&!c.restricted);
  if(keys.length!==1)continue;
  const key=keys[0],name=normal(key.name),stem=normal(object.name.replace(/^(?:tbl|tk|ref|dim)_/i,'')).replace(/^tbl/,'').replace(/(master|table|s)$/,'');
  const fullStem=normal(object.name.replace(/^(?:tbl|tk|ref|dim)_/i,'')).replace(/^tbl/,'');
  if((name!==stem+'id'&&name!==fullStem+'id')||['id','snid','nid'].includes(name))continue;
  const bucket=targets.get(name)||[];bucket.push({object,key});targets.set(name,bucket);
 }
 // A column named exactly for a table may reference its declared generic primary key.
 const tableTargets=new Map();
 for(const object of catalog.objects){
  const keys=object.columns.filter(c=>c.isPrimaryKey&&!c.restricted);
  if(keys.length!==1)continue;
  const name=normal(object.name.replace(/^(?:tbl|tk|ref|dim)_/i,'')).replace(/^tbl/,'');const bucket=tableTargets.get(name)||[];bucket.push({object,key:keys[0]});tableTargets.set(name,bucket);
 }
 const relationships=[...catalog.relationships];
 for(const source of catalog.objects)for(const column of source.columns){
  if(column.restricted||column.isPrimaryKey)continue;
  const named=targets.get(normal(column.name))||tableTargets.get(normal(column.name))||[];
  if(named.length!==1)continue;
  const candidates=named.filter(t=>t.object.id!==source.id&&type(t.key.dataType)===type(column.dataType));
  if(candidates.length!==1)continue;
  const {object:target,key}=candidates[0];
  if(relationships.some(j=>j.from===source.id&&j.to===target.id&&j.columns.length===1&&j.columns[0].from===column.name&&j.columns[0].to===key.name))continue;
  const hash=crypto.createHash('sha256').update(`${source.id}:${column.name}->${target.id}:${key.name}`).digest('hex').slice(0,16);
  relationships.push({id:`named_key_${hash}`,from:source.id,to:target.id,targetUnique:true,kind:'inferred_named_primary_key',evidence:'Matching entity or table-reference column and a declared single-column primary key; business semantics are inferred.',columns:[{from:column.name,to:key.name}]});
 }
 return {...catalog,relationships,namedKeyLinksApplied:true,namedKeyLinksVersion:4};
}
