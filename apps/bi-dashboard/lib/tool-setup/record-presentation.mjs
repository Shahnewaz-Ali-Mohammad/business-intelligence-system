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
 const allRecords=/\b(?:all|every)\s+(?:(?:the|of|these|those|matching|available)\s+)*(?:customers?|tickets?|records?|rows?|entries|results?|bills?|payments?|transactions?)\b/i.test(message);
 if(!allRecords||/\b(?:top|first|last|limit|maximum)\s+\d+/i.test(message)||definition.mode!=='rows')return args;
 if(definition.capabilities){
  const plan=typeof args.query==='string'?JSON.parse(args.query):{...(args.query||{})};
  delete plan.limit;
  return {...args,query:JSON.stringify(plan)};
 }
 const bindings={...args};delete bindings.report_limit;return bindings;
}

export function validateRecordPopulation(message,definition,catalog){
 if(definition.mode!=='rows')return;
 const requested=message.match(/\b(?:all|every)\s+(?:(?:the|of|these|those|matching|available)\s+)*(customers?|tickets?|bills?|payments?|transactions?)\b/i)?.[1]?.toLowerCase().replace(/s$/,'');
 if(!requested)return;
 const base=catalog.objects.find(o=>o.id===definition.base);
 const name=(base?.name||definition.base).replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase();
 if(!name.includes(requested))throw new Error(`The requested ${requested} records require a report at that entity's grain. This tool returns ${base?.name||definition.base} rows. Do not label these as ${requested} records; use a matching approved table or explain that it is unavailable in this workspace.`);
}
