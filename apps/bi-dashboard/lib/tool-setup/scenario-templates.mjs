import {fingerprint,fieldId,isProtectedColumn,numericType,validateTool,compileTool} from './model.mjs';
import {inferJoins} from './query-scenarios.mjs';
const comparable=c=>!isProtectedColumn(c.name)&&!/(^text$|^ntext$|image|xml|json|bytea|binary|geography|geometry)/i.test(c.dataType);
const identifier=c=>c.isPrimaryKey||/(?:id|code|key)$/i.test(c.name);
export function scenarioTemplates(catalog){
 const output=[];
 const add=(object,label,changes={})=>{
  const columns=object.columns.filter(c=>!isProtectedColumn(c.name)).map(c=>fieldId(object,c));
  const definition={name:'pending',description:label,base:object.id,joins:[],mode:'rows',columns,groupBy:[],metrics:[],filters:[],template:{projection:true,limit:true,sortFields:object.columns.filter(comparable).map(c=>fieldId(object,c)),sort:[],dateGroups:[]},...changes};
  if(definition.mode==='aggregate'&&!changes.template)definition.template={...definition.template,projection:false,sortFields:[...definition.groupBy,...definition.metrics.map(m=>m.alias)]};
  definition.name='scenario_'+fingerprint({...definition,name:undefined,description:undefined}).slice(0,24);
  validateTool(definition,catalog);output.push(definition);
 };
 for(const object of catalog.objects.filter(o=>o.kind!=='procedure')){
  const fields=object.columns.filter(c=>!isProtectedColumn(c.name));if(!fields.length)continue;
  const prefix=object.schema+'.'+object.name;
  add(object,`${prefix}: record details and list. Select approved output columns, ordering and maximum rows using report parameters.`);
  add(object,`${prefix}: total record count.`,{mode:'aggregate',columns:[],metrics:[{field:null,operation:'count',alias:'record_count'}]});
  for(const column of fields.filter(comparable)){
   const field=fieldId(object,column);
   add(object,`${prefix}: ${identifier(column)?'lookup':'records filtered'} by ${column.name}. Return matching details.`,{filters:[{field,operator:'eq',parameter:'filter_value',required:true}]});
   if(identifier(column))add(object,`${prefix}: details for a list of ${column.name} values.`,{filters:[{field,operator:'in',parameter:'filter_values',required:true}]});
   if(numericType(column.dataType)&&!identifier(column)){
    add(object,`${prefix}: statistics for ${column.name}; stored values, no inferred business formula.`,{mode:'aggregate',columns:[],metrics:['sum','avg','min','max'].map(operation=>({field,operation,alias:operation+'_value'}))});
    for(const direction of ['asc','desc'])add(object,`${prefix}: records ordered by ${column.name} ${direction==='desc'?'highest first':'lowest first'}. Set report_limit for top N.`,{template:{projection:true,limit:true,sortFields:[],sort:[{field,direction}],dateGroups:[]}});
   }
   if(/date|time/i.test(column.dataType)){
    const filters=[{field,operator:'gte',parameter:'date_from',required:false},{field,operator:'lt',parameter:'date_before',required:false}];
    add(object,`${prefix}: records in ${column.name} date range (from inclusive, before exclusive).`,{filters});
    for(const grain of ['day','month','year'])add(object,`${prefix}: record counts by ${column.name}, ${grain} buckets, with optional date range.`,{mode:'aggregate',columns:[],groupBy:[field],metrics:[{field:null,operation:'count',alias:'record_count'}],filters,template:{projection:false,limit:true,sortFields:[field,'record_count'],sort:[{field,direction:'asc'}],dateGroups:[{field,grain}]}});
   }else if(!identifier(column)&&!numericType(column.dataType))add(object,`${prefix}: record counts grouped by ${column.name}; codes retain their stored meanings.`,{mode:'aggregate',columns:[],groupBy:[field],metrics:[{field:null,operation:'count',alias:'record_count'}]});
  }
  for(const target of catalog.objects.filter(o=>o.id!==object.id&&o.kind!=='procedure')){
   const targetFields=target.columns.filter(c=>!isProtectedColumn(c.name)).map(c=>fieldId(target,c));if(!targetFields.length)continue;
   try{
    const joins=inferJoins(object.id,targetFields,catalog,catalog.relationships.filter(j=>j.targetUnique).map(j=>j.id));
    if(!joins.length)continue;
    const joinedColumns=[...fields.map(c=>fieldId(object,c)),...targetFields];
    for(const entity of [object,target])for(const key of entity.columns.filter(c=>c.isPrimaryKey&&!isProtectedColumn(c.name)))add(object,`${prefix}: joined details with ${target.schema}.${target.name}, lookup by ${entity.name}.${key.name}.`,{joins,columns:joinedColumns,filters:[{field:fieldId(entity,key),operator:'eq',parameter:'lookup_value',required:true}],template:{projection:true,limit:true,sortFields:[],sort:[],dateGroups:[]}});
    add(object,`${prefix}: joined details with ${target.schema}.${target.name} through the stored approved relationship path. Rows follow the join grain.`,{joins,columns:[...fields.map(c=>fieldId(object,c)),...targetFields],template:{projection:true,limit:true,sortFields:[],sort:[],dateGroups:[]}});
   }catch(error){if(!/Multiple relationship paths|No approved relationship|more than eight/.test(error.message))throw error;}
  }
 }
 const seen=new Set();return output.filter(t=>{const hash=fingerprint({...t,name:undefined,description:undefined});if(seen.has(hash))return false;seen.add(hash);return true;});
}
export function templateSampleParameters(definition,catalog){
 const columns=new Map(catalog.objects.flatMap(o=>o.columns.map(c=>[fieldId(o,c),c])));
 return Object.fromEntries(definition.filters.filter(f=>!['is_null','not_null'].includes(f.operator)).map(f=>{
  const type=columns.get(f.field)?.dataType||'';
  const value=/date|time/i.test(type)?'2000-01-01':/uuid|uniqueidentifier/i.test(type)?'00000000-0000-0000-0000-000000000000':numericType(type)||/bit|bool/i.test(type)?1:'__template_check__';
  return [f.parameter,f.operator==='in'?[value]:f.operator==='between'?[value,value]:value];
 }));
}
export function compileTemplateCheck(definition,catalog,dialect){
 const compiled=compileTool(definition,catalog,dialect,templateSampleParameters(definition,catalog),1);
 const alias=dialect==='mysql'?'`template_check`':dialect==='sqlserver'?'[template_check]':'"template_check"';
 return {...compiled,sql:`SELECT * FROM (${compiled.populationSql}) AS ${alias} WHERE 1=0`};
}
