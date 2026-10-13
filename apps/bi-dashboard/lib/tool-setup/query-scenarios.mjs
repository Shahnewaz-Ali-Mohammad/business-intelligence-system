import {z} from 'zod';
const scalar=z.union([z.string().max(1000),z.number().finite(),z.boolean()]);
export const queryValue=z.union([scalar,z.array(scalar).min(1).max(100)]);
export const operators=['eq','ne','gt','gte','lt','lte','contains','in','between','is_null','not_null'];
const leaf=z.object({field:z.string().min(1).max(400),operator:z.enum(operators),parameter:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),value:queryValue.optional()}).strict();
export const whereSchema=z.lazy(()=>z.union([leaf,z.object({and:z.array(whereSchema).min(1).max(50)}).strict(),z.object({or:z.array(whereSchema).min(1).max(50)}).strict(),z.object({not:whereSchema}).strict()]));
export function whereFields(node,depth=0,result=[]){
 if(!node)return result;if(depth>8||result.length>50)throw new Error('Filter expression is too complex.');
 if(node.field)result.push(node.field);else for(const child of node.and||node.or||[node.not])whereFields(child,depth+1,result);
 return result;
}
export function orientJoins(base,ids,catalog){
 const selected=new Set([base]),pending=[...ids],joins=[];
 if(new Set(ids).size!==ids.length)throw new Error('Duplicate relationships are not allowed.');
 while(pending.length){let progressed=false;
  for(let i=0;i<pending.length;i++){
   const edge=catalog.relationships.find(j=>j.id===pending[i]);
   if(!edge)throw new Error('Join must use an available foreign key.');
   if(!edge.targetUnique||!edge.columns.length)throw new Error('Join target uniqueness could not be verified.');
   if(selected.has(edge.from)&&selected.has(edge.to))throw new Error('Join repeats a table. Separate aliases are not supported.');
   if(!selected.has(edge.from)&&!selected.has(edge.to))continue;
   const reverse=selected.has(edge.to);
   const join=reverse?{...edge,from:edge.to,to:edge.from,columns:edge.columns.map(c=>({from:c.to,to:c.from})),fanout:true}:{...edge,fanout:false};
   if(!catalog.objects.some(o=>o.id===join.to))throw new Error('Join table is unavailable.');
   selected.add(join.to);joins.push(join);pending.splice(i--,1);progressed=true;
  }
  if(!progressed)throw new Error('Relationships do not form a connected path to the base table.');
 }
 return {selected,joins};
}
export function inferJoins(base,fields,catalog,allowed){
 const required=new Set(catalog.objects.filter(o=>o.columns.some(c=>fields.includes(`${o.id}:${c.name}`))).map(o=>o.id));
 const chosen=new Set();
 for(const target of required){
  if(target===base)continue;
  const queue=[base],distance=new Map([[base,0]]),counts=new Map([[base,1]]),paths=new Map([[base,[]]]);
  while(queue.length){const node=queue.shift();if(distance.get(node)>=8)continue;
    for(const edge of catalog.relationships.filter(j=>j.targetUnique&&allowed.includes(j.id))){
      const next=edge.from===node?edge.to:edge.to===node?edge.from:null;if(!next)continue;
      const step=distance.get(node)+1;
      if(!distance.has(next)){distance.set(next,step);counts.set(next,counts.get(node));paths.set(next,[...paths.get(node),edge.id]);queue.push(next);}
      else if(distance.get(next)===step)counts.set(next,Math.min(2,counts.get(next)+counts.get(node)));
    }
  }
  if(!paths.has(target))throw new Error(`No approved relationship path to ${target}.`);
  if(counts.get(target)>1)throw new Error(`Multiple relationship paths to ${target}; specify the intended join IDs.`);
  paths.get(target).forEach(id=>chosen.add(id));
 }
 if(chosen.size>8)throw new Error('This query requires more than eight relationships. Split the analysis.');
 return [...chosen];
}
export function measureIsSafe(objectId,base,joins){
 const ancestors=new Set([objectId]);let node=objectId;
 while(node!==base){const edge=joins.find(j=>j.to===node);if(!edge)return false;ancestors.add(edge.from);node=edge.from;}
 return joins.filter(j=>j.fanout).every(j=>ancestors.has(j.to));
}
export function dateExpression(ref,grain,dialect){
 if(dialect==='postgres')return `DATE_TRUNC('${grain}', ${ref})`;
 if(dialect==='mysql')return grain==='day'?`DATE(${ref})`:grain==='month'?`DATE_FORMAT(${ref}, '%Y-%m-01')`:grain==='year'?`DATE_FORMAT(${ref}, '%Y-01-01')`:`DATE_SUB(DATE(${ref}), INTERVAL WEEKDAY(${ref}) DAY)`;
 return grain==='day'?`CAST(${ref} AS date)`:grain==='month'?`DATEFROMPARTS(YEAR(${ref}),MONTH(${ref}),1)`:grain==='year'?`DATEFROMPARTS(YEAR(${ref}),1,1)`:`DATEADD(day,-((DATEDIFF(day,CONVERT(date,'19000101',112),CAST(${ref} AS date)) % 7 + 7) % 7),CAST(${ref} AS date))`;
}
