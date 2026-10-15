import {requestRequirements,splitWords,requestedBase,registryObjects} from './request-fields.mjs';
const words=value=>new Set(splitWords(value).map(w=>w.replace(/s$/,'')));
export function scenarioCandidates(message,history,tools){
 if(!tools.some(t=>t.definition.template))return tools;
 let fixed=tools.filter(t=>!t.definition.capabilities);
 const requested=requestRequirements(message,fixed);
 if(requested.identifiers.length&&requested.values.length){const fields=new Set(requested.identifiers.map(f=>f.split(':').at(-1).toLowerCase()));const exact=fixed.filter(t=>t.definition.filters.some(f=>fields.has(f.field.split(':').at(-1).toLowerCase())));if(exact.length)fixed=exact;}
 const base=requestedBase(message,registryObjects(tools));
 const terms=words(message),past=words(history.filter(h=>h.role==='user').slice(-2).map(h=>h.content).join(' '));
 const score=t=>{const d=t.definition;const text=words(d.description+' '+d.base);let n=base?(d.base===base?200:-200):0;
  for(const word of terms)if(text.has(word))n+=2;for(const word of past)if(text.has(word))n+=0.1;
  n+=d.mode===(requested.aggregate?'aggregate':'rows')?30:-30;
  if(requested.grouping.length)n+=requested.grouping.every(f=>d.groupBy.includes(f))?150:-150;
  for(const field of requested.identifiers)if(d.filters.some(f=>f.field.split(':').at(-1).toLowerCase()===field.split(':').at(-1).toLowerCase()))n+=80;
  if(requested.values.length===1&&d.filters.some(f=>f.operator==='eq'))n+=3;
  n-=d.filters.filter(f=>f.required&&!requested.identifiers.includes(f.field)).length*8;
  if(!/date|month|year|week|today|yesterday|\b20\d\d\b/i.test(message))n-=d.filters.filter(f=>f.required&&/date|time/i.test(f.field)).length*12;
  if(/top|highest|lowest/i.test(message)&&/highest first|lowest first/.test(d.description))n+=5;
  return n;
 };
 const reusable=tools.filter(t=>t.definition.capabilities);
 return [...reusable,...fixed.map((tool,index)=>({tool,index,score:score(tool)})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,24).map(x=>x.tool)];
}
export function selectedScope(catalog,tools,sourceId){
 const fields=new Set(tools.filter(t=>t.sourceId===sourceId).flatMap(t=>t.definition.capabilities?.fields||[...t.definition.columns,...t.definition.groupBy,...t.definition.metrics.map(m=>m.field),...t.definition.filters.map(f=>f.field)]));
 return catalog.objects.map(o=>({id:o.id,columns:o.columns.filter(c=>fields.has(`${o.id}:${c.name}`)).map(c=>c.name)})).filter(o=>o.columns.length);
}
