// Adds the calculations a question asks for when the planner left them out:
// shares, period changes, running totals, moving averages and rankings are
// computed by the database on top of the first returned metric.
const rules=[
  [/percent|percentage|%|share|proportion|portion|breakdown of total|of (?:the )?total/i,'percent_of_total','share_pct'],
  [/growth|grew|increase|decrease|change|vs\.? (?:last|previous|prior)|versus (?:last|previous|prior)|month[- ]over[- ]month|year[- ]over[- ]year|\bmom\b|\byoy\b|compared? (?:to|with) (?:the )?(?:last|previous|prior)/i,'percent_change','change_pct'],
  [/growth|change|difference|vs\.? (?:last|previous|prior)|month[- ]over[- ]month|year[- ]over[- ]year|\bmom\b|\byoy\b/i,'change','change_value'],
  [/running total|cumulative|to date|so far/i,'running_total','running_total'],
  [/moving average|rolling average|rolling/i,'moving_average','moving_avg'],
  [/\brank|ranking|position/i,'rank','rank'],
];
const ordered=new Set(['percent_change','change','running_total','moving_average']);
const grains=[[/\b(?:per|by|each|every) year\b|\byearly\b|\bannual(?:ly)?\b|year[- ]over[- ]year|\byoy\b|\bper annum\b/i,'year'],[/\b(?:per|by|each|every) month\b|\bmonthly\b|month[- ]over[- ]month|\bmom\b/i,'month'],[/\b(?:per|by|each|every) week\b|\bweekly\b|week[- ]over[- ]week/i,'week'],[/\b(?:per|by|each|every) day\b|\bdaily\b|day[- ]over[- ]day/i,'day']];
const isDate=(catalog,id)=>{const [object,column]=[id.slice(0,id.lastIndexOf(':')),id.slice(id.lastIndexOf(':')+1)];return /date|time/i.test(catalog?.objects?.find(o=>o.id===object)?.columns?.find(c=>c.name===column)?.dataType||'');};
export function addRequestedCalculations(message,definition,query,catalog){
  if(!definition?.capabilities||definition.mode!=='aggregate'||typeof query!=='string')return query;
  let plan;try{plan=JSON.parse(query);}catch{return query;}
  // "per year/month/..." over a grouped date field means a date bucket.
  const grain=grains.find(([pattern])=>pattern.test(message))?.[1];
  if(grain){
    const dateFields=(plan.groupBy||[]).filter(f=>isDate(catalog,f)&&!(plan.dateGroups||[]).some(g=>g.field===f));
    if(dateFields.length)plan.dateGroups=[...(plan.dateGroups||[]),{field:dateFields[0],grain}];
    else if(!(plan.dateGroups||[]).length&&!(plan.groupBy||[]).length){
      const field=(definition.capabilities.fields||[]).find(f=>isDate(catalog,f)&&new RegExp(f.split(':').pop().replace(/date|time|_/gi,''),'i').test(message))||null;
      if(field){plan.groupBy=[field];plan.dateGroups=[{field,grain}];}
    }
  }
  // Drop repeated metrics (same field and operation) and their dependents.
  const seen=new Map(),rename=new Map();
  plan.metrics=(plan.metrics||[]).filter(m=>{const key=`${m.field}|${m.operation}|${JSON.stringify(m.where||null)}`;if(seen.has(key)){rename.set(m.alias,seen.get(key));return false;}seen.set(key,m.alias);return true;});
  plan.sort=plan.sort?.map(s=>({...s,field:rename.get(s.field)||s.field}));
  plan.having=plan.having?.map(h=>({...h,field:rename.get(h.field)||h.field}));
  // A per-group percent of the same metric is always 100; a share request means percent of total.
  plan.derived=(plan.derived||[]).map(d=>({...d,inputs:d.inputs.map(i=>rename.get(i)||i)})).filter(d=>!(d.operation==='percent_of'&&d.inputs[0]===d.inputs[1]));
  if(!plan.derived.length)delete plan.derived;
  const metric=plan.metrics?.[0]?.alias;if(!metric)return query;
  const derived=[...(plan.derived||[])];const have=new Set(derived.map(d=>d.operation));
  const grouped=(plan.groupBy?.length||plan.dateGroups?.length);
  for(const [pattern,operation,alias] of rules){
    if(have.has(operation)||!pattern.test(message))continue;
    if((ordered.has(operation)||operation==='percent_of_total'||operation==='rank')&&!grouped)continue;
    if(derived.some(d=>d.alias===alias))continue;
    derived.push({alias,operation,inputs:[metric],...(operation==='moving_average'?{window:3}:{})});have.add(operation);
  }
  // Period comparisons and running figures read in time order.
  const key=plan.dateGroups?.[0]?.field||plan.groupBy?.[0];
  if(key&&derived.some(d=>ordered.has(d.operation))&&!(plan.sort||[]).some(s=>s.field===key))plan.sort=[{field:key,direction:'asc'}];
  return JSON.stringify(derived.length?{...plan,derived}:plan);
}
