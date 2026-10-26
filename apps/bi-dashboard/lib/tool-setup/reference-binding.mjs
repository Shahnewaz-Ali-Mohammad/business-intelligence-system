import {numericType} from './model.mjs';
const numeric=value=>typeof value!=='string'||/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
// A label belongs on the readable side of an approved reference relationship, never an integer key.
export function groundReferenceLabels(definition,catalog,query){
 if(!definition.capabilities)return query;
 const plan=JSON.parse(query);let changed=false;
 const columns=new Map(catalog.objects.flatMap(o=>o.columns.map(c=>[o.id+':'+c.name,c])));
 const visit=node=>{
  if(!node)return;
  if(!node.field){for(const child of node.and||node.or||[node.not])visit(child);return;}
  const column=columns.get(node.field);const values=Array.isArray(node.value)?node.value:[node.value];
  if(!numericType(column?.dataType||'')||!values.some(v=>typeof v==='string'&&!numeric(v))||!['eq','ne','in'].includes(node.operator))return;
  const candidates=[];
  for(const edge of catalog.relationships){
   if(!definition.capabilities.joins.includes(edge.id)||edge.columns.length!==1||node.field!==edge.from+':'+edge.columns[0].from)continue;
   const target=catalog.objects.find(o=>o.id===edge.to);
   const labels=target?.columns.filter(c=>/char|text/i.test(c.dataType)&&/^(?:name|description)$|(?:type|status|category)name$/i.test(c.name)&&definition.capabilities.fields.includes(target.id+':'+c.name))||[];
   if(labels.length===1)candidates.push({field:target.id+':'+labels[0].name,edge:edge.id});
  }
  if(candidates.length!==1)return;
  node.field=candidates[0].field;changed=true;
  if(plan.joins&&!plan.joins.includes(candidates[0].edge))plan.joins.push(candidates[0].edge);
 };
 visit(plan.where);for(const metric of plan.metrics||[])visit(metric.where);
 return changed?JSON.stringify(plan):query;
}
