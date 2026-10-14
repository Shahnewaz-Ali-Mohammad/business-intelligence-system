const words=value=>new Set((value.replace(/([a-z0-9])([A-Z])/g,'$1 $2').match(/[a-z][a-z0-9]*/gi)||[]).map(w=>w.toLowerCase().replace(/s$/,'')));
export function scenarioCandidates(message,history,tools){
 if(!tools.some(t=>t.definition.template))return tools;
 let fixed=tools.filter(t=>!t.definition.capabilities);
 const namedId=message.match(/\b([a-z]+)\s+id\b/i)?.[1];
 if(namedId&&/\d{3,}/.test(message)){
  const exact=fixed.filter(t=>t.definition.filters.some(f=>f.field.split(':').at(-1).toLowerCase()===namedId.toLowerCase()+'id'));
  if(exact.length)fixed=exact;
 }
 const terms=words(message+' '+history.slice(-2).map(h=>h.content).join(' '));
 const detail=/detail|list|show|record|customer/i.test(message)&&!/count|sum|average|total|trend|by /i.test(message);
 const score=t=>{const d=t.definition;const text=words(d.description+' '+d.base);let n=0;for(const word of terms)if(text.has(word))n+=3;
  if(detail&&d.mode==='rows')n+=5;if(!detail&&d.mode==='aggregate')n+=3;
  if(/\b\d{3,}\b/.test(message)&&d.filters.some(f=>/id|key|code/i.test(f.field)&&f.required))n+=8;
  if(/top|highest|lowest/i.test(message)&&/highest first|lowest first/.test(d.description))n+=5;
  return n;
 };
 return fixed.map((tool,index)=>({tool,index,score:score(tool)})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,24).map(x=>x.tool);
}
export function selectedScope(catalog,tools,sourceId){
 const fields=new Set(tools.filter(t=>t.sourceId===sourceId).flatMap(t=>t.definition.capabilities?.fields||[...t.definition.columns,...t.definition.groupBy,...t.definition.metrics.map(m=>m.field),...t.definition.filters.map(f=>f.field)]));
 return catalog.objects.map(o=>({id:o.id,columns:o.columns.filter(c=>fields.has(`${o.id}:${c.name}`)).map(c=>c.name)})).filter(o=>o.columns.length);
}
