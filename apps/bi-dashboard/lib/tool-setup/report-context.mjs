export function reportContext(answer,message){
 if(!answer?.query)return null;
 let query;try{query=JSON.parse(answer.query);}catch{return null;}
 const identifiers=new Set(message.match(/\b\d{3,}\b/g)||[]),matches=[];
 for(const row of answer.rows||[])for(const [field,value] of Object.entries(row)){
  if(matches.length>=10)break;
  if(/(?:id|key|code|number)$/i.test(field)&&identifiers.has(String(value))&&!matches.some(m=>m.field===field&&m.value===String(value)))matches.push({field,value:String(value)});
 }
 return {tool:answer.toolName,mode:answer.mode,query,outputFields:Object.keys(answer.rows?.[0]||{}).slice(0,60),identifierMatches:matches};
}
