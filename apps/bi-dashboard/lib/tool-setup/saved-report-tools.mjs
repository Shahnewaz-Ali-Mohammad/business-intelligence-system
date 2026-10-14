import {tool} from '@langchain/core/tools';
import {z} from 'zod';
import {mcpToolName} from './mcp.mjs';
import {scenarioCandidates} from './scenario-selection.mjs';
const scalar=z.union([z.string().max(20000),z.number().finite(),z.boolean()]);
export function savedReportTools(client,registry){
 const reports=registry.filter(t=>t.status==='approved'&&!t.definition.capabilities);
 const byName=new Map(reports.map(t=>[mcpToolName(t.sourceId,t.definition.name),t]));
 return [tool(async({request})=>{
  const terms=(request.match(/[a-z]+/gi)||[]).map(w=>w.toLowerCase());
  const chosen=scenarioCandidates(request,[],reports).slice(0,6);
  return JSON.stringify({reports:chosen.map(t=>{
   const d=t.definition;
   const relevant=d.columns.filter(f=>terms.some(w=>w.length>2&&f.split(':').at(-1).toLowerCase().includes(w)));
   return {report_name:mcpToolName(t.sourceId,d.name),description:d.description,mode:d.mode,
    parameters:d.filters.map(f=>({name:f.parameter,field:f.field,operator:f.operator,required:f.required})),
    controls:d.template?{report_limit:d.template.limit?'optional integer, 1 to 100000':false,report_columns:d.template.projection?'optional list of output field IDs; omit for all fields':false,report_sort_field:d.template.sortFields.filter(f=>terms.some(w=>w.length>2&&f.split(':').at(-1).toLowerCase().includes(w))).slice(0,12),report_sort_direction:['asc','desc']}:null,
    output_fields:relevant.length?relevant:d.columns.slice(0,8),output_field_count:d.columns.length,
    note:'Joins and calculations are already stored. Supply only parameter values. For all details omit report_columns.'};
  }),note:'If these reports do not fit, search again with the exact missing tables, fields or metric. An execution failure is not a missing scenario.'});
 },{name:'find_saved_reports',description:'Find prebuilt, approved report templates for this workspace. Search before running a report. Include the entity, desired output, filters, grouping and ranking. This returns named reports and their typed parameter requirements; no query generation.',schema:z.object({request:z.string().min(1).max(4000)})}),
 tool(async({report_name,parameters})=>{
  if(!byName.has(report_name))throw Error('Choose an approved saved report returned by find_saved_reports.');
  if('query' in parameters)throw Error('Saved reports accept parameter values only, not a query plan.');
  const result=await client.callTool({name:report_name,arguments:parameters});
  if(result.isError)throw Error(result.content.filter(b=>b.type==='text').map(b=>b.text).join(' '));
  return result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
 },{name:'run_saved_report',description:'Execute an already-built approved report by its exact report_name, supplying only the parameter values and supported report display controls returned by find_saved_reports. Never supply SQL, joins, metrics or a query plan. The application renders the returned report table.',schema:z.object({report_name:z.string().min(1),parameters:z.record(z.string(),z.union([scalar,z.array(scalar).max(1000)]))})})];
}
