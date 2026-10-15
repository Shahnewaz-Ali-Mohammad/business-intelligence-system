// Only resolve explicit, simple entity-ID detail requests. Compound analytics
// and ambiguous identifiers remain with the agent; no filters are guessed.
export function resolveSavedLookup(message,registry){
 const idName=message.match(/\b([a-z]+)\s+id\b/i)?.[1]?.toLowerCase();
 if(!idName)return null;
 const values=message.match(/\b(?:[a-z]+[-_])?\d+\b/gi)||[];
 if(values.length!==1)return null;
 const allowed=new Set(['show','me','all','the','detail','details','for','this','id','please','give','get','record','records','of',idName]);
 const remainder=message.replace(values[0],'').toLowerCase().match(/[a-z]+/g)||[];
 if(remainder.some(word=>!allowed.has(word)))return null;
 const candidates=registry.filter(t=>{
  const d=t.definition;
  const entity=d.base.split('.').at(-1).toLowerCase().replace(/^tbl/,'').replace(/(?:master|table|s)$/,'');
  return !d.capabilities&&d.mode==='rows'&&!d.joins.length&&entity===idName&&d.filters.length===1&&d.filters[0].required&&d.filters[0].field.split(':').at(-1).toLowerCase()===idName+'id'&&['eq','in'].includes(d.filters[0].operator);
 }).sort((a,b)=>Number(b.status==='approved')-Number(a.status==='approved')||b.definition.columns.length-a.definition.columns.length||Number(a.definition.filters[0].operator==='in')-Number(b.definition.filters[0].operator==='in')||a.definition.name.localeCompare(b.definition.name));
 if(!candidates.length)return null;
 const chosen=candidates[0],filter=chosen.definition.filters[0];
 return {chosen,parameters:{[filter.parameter]:filter.operator==='in'?[values[0]]:values[0]}};
}
export function missingReportDecision({message,gap,registry,completed=0,failed=false}){
 if(completed)return {kind:'executed'};
 if(failed)return {kind:'execution_error'};
 const lookup=resolveSavedLookup(message,registry);
 if(lookup)return {kind:lookup.chosen.status==='approved'?'existing':'needs_approval',lookup};
 if(/not exist|not found|no (?:details|records|results|data)|zero (?:records|rows)/i.test(gap||''))return {kind:'not_a_capability_gap'};
 return {kind:'missing'};
}
