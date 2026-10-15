import {fingerprint} from './model.mjs';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
export function reportShape(definition,{omitColumns=false}={}){
 const {template,filters=[]}=definition;
 const shape={...definition};delete shape.name;delete shape.description;delete shape.template;
 const metricNames=new Map((definition.metrics||[]).map((metric,index)=>[metric.alias,'m'+index]));
 shape.metrics=(definition.metrics||[]).map((metric,index)=>({...metric,alias:'m'+index}));
 const parameters=new Map();
 const ordered=[...filters].sort((a,b)=>`${a.field}:${a.operator}:${a.required}`.localeCompare(`${b.field}:${b.operator}:${b.required}`));
 shape.filters=ordered.map(f=>{if(!parameters.has(f.parameter))parameters.set(f.parameter,'p'+parameters.size);return {...f,parameter:parameters.get(f.parameter)};});
 if(omitColumns)delete shape.columns;else if(shape.columns)shape.columns=[...shape.columns].sort();
 if(shape.joins)shape.joins=[...shape.joins].sort();
 if(shape.capabilities)shape.capabilities={fields:[...shape.capabilities.fields].sort(),joins:[...shape.capabilities.joins].sort()};
 // Display permissions do not create a different report. Stored default
 // ordering and date buckets DO change which records/groups the report returns.
 shape.template={sort:(template?.sort||[]).map(sort=>({...sort,field:metricNames.get(sort.field)||sort.field})),dateGroups:template?.dateGroups||[]};
 return stable(shape);
}
export const reportFingerprint=definition=>fingerprint(reportShape(definition));
export function reportCovers(existing,candidate){
 if(reportFingerprint(existing)===reportFingerprint(candidate))return true;
 if(existing.capabilities||candidate.capabilities||existing.mode!=='rows'||candidate.mode!=='rows'||!existing.template?.projection)return false;
 const fields=new Set(existing.columns);
 return candidate.columns.every(f=>fields.has(f))&&fingerprint(reportShape(existing,{omitColumns:true}))===fingerprint(reportShape(candidate,{omitColumns:true}));
}
export function uniqueReports(registry){
 const groups=new Map();
 for(const entry of registry){const key=fingerprint(reportShape(entry.definition,{omitColumns:true}));const group=groups.get(key)||[];group.push(entry);groups.set(key,group);}
 return [...groups.values()].flatMap(group=>{
  const kept=[];
  for(const entry of group.sort((a,b)=>(b.definition.columns?.length||0)-(a.definition.columns?.length||0)||a.definition.name.localeCompare(b.definition.name))){if(!kept.some(t=>reportCovers(t.definition,entry.definition)))kept.push(entry);}
  return kept;
 });
}
