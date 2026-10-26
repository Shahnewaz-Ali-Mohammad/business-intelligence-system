// A failed literal phrase search is not evidence that its business category is absent.
export async function labelRecovery({message,definition,query,result,approvedTools,catalog,execute}){
 if(definition.mode!=='rows'||result.rows.length||!definition.capabilities)return [];
 const plan=JSON.parse(query),leaves=[];
 const visit=node=>{if(!node)return;if(node.field)leaves.push(node);else for(const child of node.and||node.or||[node.not])visit(child);};visit(plan.where);
 const searches=leaves.filter(f=>['contains','eq'].includes(f.operator)&&typeof f.value==='string'&&/subject|description|type|status|category|priority/i.test(f.field.split(':').at(-1))&&!message.toLowerCase().includes('"'+f.value.toLowerCase()+'"')&&!message.toLowerCase().includes("'"+f.value.toLowerCase()+"'"));
 if(!searches.length)return [];
 const stop=new Set(['the','and','for','with','about','this','that','being','still','are','was','have','has','only','show']);
 const terms=[...new Set(searches.flatMap(f=>(f.value.toLowerCase().match(/[a-z]+/g)||[]).filter(w=>w.length>2&&!stop.has(w)).map(w=>w.replace(/(?:ing|ed)$/,''))))].filter(w=>w.length>2).slice(0,5);
 if(!terms.length)return [];
 const fields=[...new Set(approvedTools.flatMap(t=>t.definition.capabilities?.fields||[]))].filter(field=>{
  const object=catalog.objects.find(o=>field.startsWith(o.id+':'));const column=object?.columns.find(c=>field===object.id+':'+c.name);
  return column&&/char|text/i.test(column.dataType)&&/(?:type|status|category).*name|^description$|^priority$/i.test(column.name);
 });
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
