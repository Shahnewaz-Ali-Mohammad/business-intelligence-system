import {compileTemplateCheck} from '../lib/tool-setup/scenario-templates.mjs';
import {withDatabase,discoverDatabase} from '../lib/tool-setup/connectors.mjs';
import {decryptConnectionString} from '../lib/workspaces/secrets.ts';
import mysql from 'mysql2/promise';
import {coverageReport} from '../lib/tool-setup/coverage.mjs';
import {generateTools} from '../lib/tool-setup/generate.ts';
import {saveDraftDefinitions} from '../lib/tool-setup/draft-storage.mjs';
import {readJob,updateJob} from '../lib/tool-setup/generation-job-store.mjs';
const [workspaceId,jobId]=process.argv.slice(2);
const db=mysql.createPool({host:process.env.DB_APP_HOST||'localhost',port:Number(process.env.DB_APP_PORT||3306),database:process.env.DB_APP_NAME||'bi_app',user:process.env.DB_APP_USER||'bi_app_user',password:process.env.DB_APP_PASSWORD||'',connectionLimit:3});
const controller=new AbortController();let heartbeat;let owned=false;
const mine=job=>job.status==='running'&&job.workerPid===process.pid;
try{
 const job=await updateJob(workspaceId,jobId,current=>current.status==='queued'?{...current,status:'running',workerPid:process.pid,heartbeatAt:Date.now()}:null);
 if(!job){await db.end();process.exit(0);}owned=true;
 heartbeat=setInterval(async()=>{
  try{const updated=await updateJob(workspaceId,jobId,current=>mine(current)?{...current,heartbeatAt:Date.now()}:null);if(!updated)controller.abort(new Error('Generation cancelled'));}
  catch{controller.abort(new Error('Generation status storage failed'));}
 },10000);
 const definitions=await generateTools(job.input.catalog,job.input.selected,job.input.request,{
  signal:controller.signal,completedBatches:job.checkpoints,missingOnly:job.input.missingOnly,
  onProgress:async(message)=>{const updated=await updateJob(workspaceId,jobId,current=>mine(current)?{...current,progress:message}:null);if(!updated)controller.abort(new Error('Generation cancelled'));},
  onBatchValidated:async(index,tools)=>{await updateJob(workspaceId,jobId,current=>mine(current)?{...current,checkpoints:{...current.checkpoints,[index]:tools}}:null);}
 });
 if(!mine(await readJob(workspaceId,jobId)))throw new Error('Generation cancelled');
 const [sources]=await db.execute('SELECT s.database_name,v.encrypted_config FROM bi_tool_sources s JOIN bi_tool_servers v ON v.id=s.server_id WHERE s.id=? AND v.workspace_id=?',[job.sourceId,workspaceId]);
 if(!sources[0])throw new Error('Database source unavailable.');
 const config={...JSON.parse(decryptConnectionString(sources[0].encrypted_config)),database:sources[0].database_name};
 const validationCatalog=await discoverDatabase(config);
 if(validationCatalog.fingerprint!==job.input.catalog.fingerprint)throw new Error('Database structure changed during generation. Discover objects again.');
 let checked=0;
 await withDatabase(config,async query=>{
  for(const definition of definitions){
   controller.signal.throwIfAborted();
   const compiled=compileTemplateCheck(definition,validationCatalog,config.dialect);
   try{await query(compiled.sql,compiled.values);}catch(error){console.error('[template preflight]',definition.name,error instanceof Error?error.message:error);throw new Error(`Report ${definition.name} failed database preflight. No new drafts were saved.`);}
   checked++;
   if(checked%10===0)await updateJob(workspaceId,jobId,current=>mine(current)?{...current,progress:`Database preflight ${checked} of ${definitions.length} saved templates`}:null);
  }
 });
 let saved;const connection=await db.getConnection();try{saved=await saveDraftDefinitions(connection,job.sourceId,job.input.catalog.fingerprint,definitions,{additive:!!job.input.missingOnly});}finally{connection.release();}
 const result={preflightCount:checked,coverage:coverageReport(job.input.catalog,definitions),count:definitions.length,genericCount:definitions.filter(t=>t.name.startsWith('schema_')).length,templateCount:definitions.filter(t=>t.template).length,aiCount:definitions.filter(t=>!t.name.startsWith('schema_')&&!t.name.startsWith('scenario_')).length,...saved};
 await updateJob(workspaceId,jobId,current=>mine(current)?{...current,status:'completed',progress:'Database-preflighted report templates saved for approval',result,heartbeatAt:Date.now()}:null);
}catch(error){if(owned)await updateJob(workspaceId,jobId,current=>mine(current)?{...current,status:'failed',error:error instanceof Error?error.message:'Generation failed',progress:'Stopped; completed schema groups kept for retry'}:null).catch(()=>{});}
finally{clearInterval(heartbeat);await db.end();}
