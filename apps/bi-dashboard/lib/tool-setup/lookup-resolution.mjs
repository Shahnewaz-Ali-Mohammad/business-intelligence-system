import {requestRequirements,splitWords,fieldAliases} from './request-fields.mjs';
const filler=['show','me','all','the','detail','details','for','this','please','give','get','record','records','of','information','info','need','i'];
export function resolveSavedLookup(message,registry){
 const requested=requestRequirements(message,registry);
 if(requested.aggregate||requested.values.length!==1||!requested.identifiers.length)return null;
 const wanted=new Set(requested.identifiers.map(f=>f.split(':').at(-1).toLowerCase()));
 const candidates=registry.filter(t=>{
  const d=t.definition;if(!d.filters[0]?.field.startsWith(d.base+':')||d.capabilities||d.mode!=='rows'||d.joins.length||d.filters.length!==1||!d.filters[0].required||!['eq','in'].includes(d.filters[0].operator)||!wanted.has(d.filters[0].field.split(':').at(-1).toLowerCase()))return false;
  const allowed=new Set([...filler,...fieldAliases(d.filters[0].field).flatMap(splitWords),...splitWords(d.base.split('.').at(-1)).filter(w=>!['tk','tbl','master','info','log'].includes(w))]);
  const remainder=message.replace(requested.values[0],'');
  return splitWords(remainder).every(w=>allowed.has(w)||allowed.has(w.replace(/s$/,'')));
 }).sort((a,b)=>Number(b.status==='approved')-Number(a.status==='approved')||b.definition.columns.length-a.definition.columns.length||Number(a.definition.filters[0].operator==='in')-Number(b.definition.filters[0].operator==='in')||a.definition.name.localeCompare(b.definition.name));
 if(!candidates.length)return null;
 const chosen=candidates[0],filter=chosen.definition.filters[0];return {chosen,parameters:{[filter.parameter]:filter.operator==='in'?[requested.values[0]]:requested.values[0]}};
}
export function resolveSavedGrouping(message,registry){
 const requested=requestRequirements(message,registry);
 if(!requested.aggregate||requested.grouping.length!==1||requested.values.length||/average|sum|distinct|revenue|amount|balance/i.test(message))return null;
 const candidates=registry.filter(t=>{const d=t.definition;return !d.capabilities&&d.mode==='aggregate'&&d.groupBy.length===1&&d.groupBy[0]===requested.grouping[0]&&!d.joins.length&&!d.filters.some(f=>f.required)&&d.metrics.length===1&&d.metrics[0].operation==='count'&&d.metrics[0].field===null&&!d.template?.dateGroups?.length;});
 const match=candidates.sort((a,b)=>Number(b.status==='approved')-Number(a.status==='approved')||a.definition.name.localeCompare(b.definition.name)).find(t=>{
  const allowed=new Set(['show','me','give','get','total','totals','count','counts','how','many','for','each','by','per','the','all','please',...splitWords(t.definition.base.split('.').at(-1)),...splitWords(requested.grouping[0].split(':').at(-1))]);
  return splitWords(message).every(w=>allowed.has(w)||allowed.has(w.replace(/s$/,'')));
 });
 return match?{chosen:match,parameters:{}}:null;
}
export const resolveSavedRequest=(message,registry)=>resolveSavedLookup(message,registry)||resolveSavedGrouping(message,registry);
export function missingReportDecision({message,gap,registry,completed=0,failed=false}){
 if(completed)return {kind:'executed'};
 if(failed)return {kind:'execution_error'};
 const lookup=resolveSavedRequest(message,registry);
 if(lookup)return {kind:lookup.chosen.status==='approved'?'existing':'needs_approval',lookup};
 if(/not exist|not found|no (?:details|records|results|data|matching|category|categories|labels)|zero (?:records|rows)/i.test(gap||''))return {kind:'not_a_capability_gap'};
 return {kind:'missing'};
}
