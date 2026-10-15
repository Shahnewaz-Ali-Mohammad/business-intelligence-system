import {requestedBase} from './request-fields.mjs';
export function recordNarrative(result, summary, query) {
  const population = summary?.population === undefined ? (result.hasMore ? undefined : result.rows.length) : Number(summary.population);
  const count = Number.isSafeInteger(population) && population >= 0 ? population : undefined;
  if (count === 0) return 'No records match the requested filters.';
  let text = count === undefined ? 'Matching records are available in the table below.' : `${count.toLocaleString()} matching ${count === 1 ? 'record' : 'records'}. Details are available in the table below.`;
  const plan = JSON.parse(query);
  if (plan.limit && !plan.sort?.length) text += ' This list uses the default record order.';
  return text;
}

// A display page size must not become an unrequested population limit.
export function requestedRecordArguments(message, definition, args) {
 const explicitLimit=/\b(?:top|first|last|limit|maximum|up to|fetch|show|return)\s+\d+|\b\d+\s+(?:rows?|records?|results?)\b/i.test(message);
 if(explicitLimit||definition.mode!=='rows')return args;
 if(definition.capabilities){
  const plan=typeof args.query==='string'?JSON.parse(args.query):{...(args.query||{})};
  delete plan.limit;
  return {...args,query:JSON.stringify(plan)};
 }
 const bindings={...args};delete bindings.report_limit;return bindings;
}

export function validateRecordPopulation(message,definition,catalog){
 const base=requestedBase(message,catalog.objects);
 const noun=message.match(/\b(?:all|every)\s+(?:(?:the|of|these|those|matching|available)\s+)*([a-z]+)/i)?.[1]?.toLowerCase().replace(/s$/,'');
 if(!base&&noun&&!['column','field','detail','record','row','result','data','information'].includes(noun)&&!definition.base.toLowerCase().includes(noun))throw new Error('The requested '+noun+' records are not represented by this report table. Do not substitute a different entity.');
 if(base&&definition.base!==base)throw new Error(`Use the requested table ${base}; this report uses ${definition.base}. Shared key names do not make these the same entity.`);
}
