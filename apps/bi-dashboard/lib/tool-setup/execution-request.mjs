import {requestRequirements} from './request-fields.mjs';
import {compileTool} from './model.mjs';
import {requiresDetailedReport} from './chat-planning.mjs';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function validateExecutionRequest(message,definition,catalog,dialect,parameters){
 if(requiresDetailedReport(message)&&definition.mode!=='rows')throw new Error('This request needs a record list, not an aggregate report.');
 if(requestRequirements(message,[definition]).aggregate&&definition.mode!=='aggregate')throw new Error('This request needs an aggregate report, not a record list.');
 const plan=JSON.parse(parameters.query);
 if(/\b(?:about|regarding|related to)\s+\S+/i.test(message)&&!plan.where&&!definition.filters.length){
  const topic=message.match(/\b(?:about|regarding|related to)\s+(.+)/i)?.[1]?.replace(/[.?!]+$/,'').trim()||'';
  const baseName=definition.base.split('.').at(-1).replace(/^(?:tk|tbl)_/i,'').replace(/(?:InfoMaster|Master)$/i,'').toLowerCase();
  if(topic.toLowerCase().replace(/s$/,'')!==baseName.replace(/s$/,''))throw new Error('The requested topic restriction is missing. Preserve the employee category filter instead of returning every record.');
 }
 const compiled=compileTool(definition,catalog,dialect,parameters,1);
 if(/\bjoin\b/i.test(message)){
  const mentioned=catalog.objects.filter(o=>new RegExp('\\b'+escape(o.id)+'\\b','i').test(message));
  const reached=new Set([definition.base,...compiled.joinIds.flatMap(id=>{const edge=catalog.relationships.find(j=>j.id===id);return edge?[edge.from,edge.to]:[];})]);
  if(mentioned.some(o=>!reached.has(o.id)))throw new Error('The requested join was not executed. Use the approved relationship path and preserve the requested tables.');
 }
 const group=message.match(/\bgroup(?:ed)?\s+by\s+(.+)/i)?.[1];
 if(group){
  for(const object of catalog.objects)for(const column of object.columns){
   const names=[object.id,object.name].map(escape).join('|');
   if(new RegExp('(?:'+names+')[.:]'+escape(column.name)+'\\b','i').test(group)&&!compiled.outputFields.includes(object.id+':'+column.name))
    throw new Error('The requested grouping field '+object.id+':'+column.name+' is missing. Do not substitute its ID or drop the requested join.');
  }
 }
 return compiled;
}
