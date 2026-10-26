// A failed literal phrase search is not evidence that its business category is absent.
const stop=new Set(['the','and','for','with','about','this','that','being','still','are','was','have','has','only','show','give','tell','ticket','tickets','record','records','data','report','reports','please','ones']);
const stem=word=>word.toLowerCase().replace(/(?:ies)$/,'y').replace(/(?:ing|ed)$/,'').replace(/s$/,'');
const words=text=>[...new Set((String(text).toLowerCase().match(/[a-z]+/g)||[]).filter(word=>word.length>2&&!stop.has(word)).map(stem).filter(word=>word.length>2))];
const referenceFields=(approvedTools,catalog)=>[...new Set(approvedTools.flatMap(t=>t.definition.capabilities?.fields||[]))].filter(field=>{
 const object=catalog.objects.find(o=>field.startsWith(o.id+':'));const column=object?.columns.find(c=>field===object.id+':'+c.name);
 return column&&/char|text/i.test(column.dataType)&&/(?:type|status|category).*name|^description$|^priority$/i.test(column.name);
});

/** Finds one unambiguous stored label per reference field for the current wording. */
export async function relevantLabelEvidence({message,approvedTools,catalog,execute}){
 const terms=words(message).slice(0,6);if(!terms.length)return [];
 const evidence=[];
 for(const field of referenceFields(approvedTools,catalog).slice(0,8)){
  const candidates=approvedTools.filter(t=>t.definition.mode==='aggregate'&&t.definition.capabilities?.fields.includes(field));
  const tool=candidates.find(t=>field.startsWith(t.definition.base+':'))||candidates[0];if(!tool)continue;
  const filters=terms.map(value=>({field,operator:'contains',value}));
  const query=JSON.stringify({groupBy:[field],metrics:[{field:null,operation:'count',alias:'occurrences'}],where:filters.length===1?filters[0]:{or:filters},limit:20});
  const result=await execute(tool,query);
  const matches=[...new Set(result.rows.map(row=>row[field]).filter(value=>value!==null&&value!==undefined).map(String).filter(value=>words(value).some(word=>terms.includes(word))))];
  if(matches.length===1)evidence.push({field,value:matches[0]});
 }
 return evidence;
}

const leavesOf=(node,out=[])=>{if(!node)return out;if(node.field)out.push(node);else for(const child of node.and||node.or||[node.not])leavesOf(child,out);return out;};
export function assertRelevantLabels(query,evidence){
 if(!evidence?.length)return;
 const leaves=leavesOf(JSON.parse(query).where);
 const missing=evidence.filter(item=>!leaves.some(leaf=>leaf.field===item.field&&['eq','in'].includes(leaf.operator)&&(leaf.operator==='in'?Array.isArray(leaf.value)&&leaf.value.some(value=>String(value).toLowerCase()===item.value.toLowerCase()):String(leaf.value).toLowerCase()===item.value.toLowerCase())));
 if(missing.length)throw new Error('Verified request filters are missing. Preserve the earlier filters and add these exact stored labels: '+JSON.stringify(missing)+'.');
}
export async function labelRecovery({message,definition,query,result,approvedTools,catalog,execute}){
 if(definition.mode!=='rows'||result.rows.length||!definition.capabilities)return [];
 const plan=JSON.parse(query),leaves=[];
 const visit=node=>{if(!node)return;if(node.field)leaves.push(node);else for(const child of node.and||node.or||[node.not])visit(child);};visit(plan.where);
 const searches=leaves.filter(f=>['contains','eq'].includes(f.operator)&&typeof f.value==='string'&&/subject|description|type|status|category|priority/i.test(f.field.split(':').at(-1))&&!message.toLowerCase().includes('"'+f.value.toLowerCase()+'"')&&!message.toLowerCase().includes("'"+f.value.toLowerCase()+"'"));
 if(!searches.length)return [];
 const terms=[...new Set(searches.flatMap(f=>words(f.value)))].slice(0,5);
 if(!terms.length)return [];
 const fields=referenceFields(approvedTools,catalog);
 const evidence=[];
 for(const field of fields.slice(0,6)){
  const candidates=approvedTools.filter(t=>t.definition.mode==='aggregate'&&t.definition.capabilities?.fields.includes(field));
  const tool=candidates.find(t=>field.startsWith(t.definition.base+':'))||candidates[0];if(!tool)continue;
  const filters=terms.map(value=>({field,operator:'contains',value}));
  const query=JSON.stringify({groupBy:[field],metrics:[{field:null,operation:'count',alias:'occurrences'}],where:filters.length===1?filters[0]:{or:filters},limit:12});
  const labels=await execute(tool,query);const values=labels.rows.map(row=>row[field]).filter(v=>v!==null&&v!==undefined);
  if(values.length)evidence.push({field,values});
 }
 return evidence;
}
