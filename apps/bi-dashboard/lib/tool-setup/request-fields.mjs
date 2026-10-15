export const splitWords=value=>(value.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_\W]+/g,' ').toLowerCase().match(/[a-z0-9]+/g)||[]);
export const normalize=value=>splitWords(value).join('');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function fieldAliases(field){
 const name=field.split(':').at(-1),words=splitWords(name),aliases=[name,words.join(' '),words.join('')];
 if(/no$/i.test(name)){const stem=name.slice(0,-2);aliases.push(stem+' number',splitWords(stem).join(' ')+' number');}
 return [...new Set(aliases.map(a=>a.toLowerCase()))];
}
export function mentionsField(message,field){
 return fieldAliases(field).some(alias=>new RegExp('\\b'+escape(alias).replace(/ /g,'\\s*')+'\\b','i').test(message));
}
export function mentionedFields(message,fields){
 return [...new Set(fields)].filter(field=>mentionsField(message,field)&&!fieldAliases(field).some(alias=>new RegExp('\\bnot\\s+(?:the\\s+)?'+escape(alias).replace(/ /g,'\\s*')+'\\b','i').test(message)));
}
export const identifierField=field=>/(?:id|no|number|key|code)$/i.test(field.split(':').at(-1));
export function requestRequirements(message,registry){
 const definitions=registry.map(t=>t.definition||t);
 const fields=[...new Set(definitions.flatMap(d=>[...d.columns,...d.groupBy,...d.filters.map(f=>f.field),...d.metrics.map(m=>m.field).filter(Boolean)]))];
 const aggregate=/\b(count|total|totals|how many|average|sum|breakdown|trend|statistics)\b/i.test(message);
 const groupText=message.match(/\b(?:by|per|each)\s+(.+)/i)?.[1]||'';
 const grouping=aggregate?mentionedFields(groupText,fields):[];
 const identifiers=mentionedFields(message,fields.filter(identifierField));
 const values=(message.match(/\b[a-z0-9]+(?:[-_][a-z0-9]+)*\b/gi)||[]).filter(v=>/\d/.test(v));
 return {aggregate,grouping,identifiers,values};
}
export function validateReportSelection(message,definition,registry){
 const requested=requestRequirements(message,registry);
 if(requested.aggregate&&definition.mode!=='aggregate')throw Error('This request needs an aggregate report, not a record list.');
 if(requested.grouping.length&&!requested.grouping.every(field=>definition.groupBy.includes(field)))throw Error('Choose the stored report grouped by '+requested.grouping.join(', ')+'. Do not substitute unrelated totals.');
 if(requested.identifiers.length&&requested.values.length){
  const names=new Set(requested.identifiers.map(f=>f.split(':').at(-1).toLowerCase()));
  if(!definition.filters.some(f=>names.has(f.field.split(':').at(-1).toLowerCase())&&['eq','in'].includes(f.operator)))throw Error('Use the requested identifier filter: '+[...names].join(', ')+'. A different ID field cannot be substituted.');
 }
 if(!requested.values.length&&!requested.identifiers.length&&definition.filters.some(f=>f.required&&identifierField(f.field)))throw Error('This report requires an identifier that the user did not provide. Find a report supporting the requested category or grouping.');
 return requested;
}
