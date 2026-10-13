import mysql from 'mysql2/promise';
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
  signal:controller.signal,completedBatches:job.checkpoints,
  onProgress:async(message)=>{const updated=await updateJob(workspaceId,jobId,current=>mine(current)?{...current,progress:message}:null);if(!updated)controller.abort(new Error('Generation cancelled'));},
  onBatchValidated:async(index,tools)=>{await updateJob(workspaceId,jobId,current=>mine(current)?{...current,checkpoints:{...current.checkpoints,[index]:tools}}:null);}
 });
 if(!mine(await readJob(workspaceId,jobId)))throw new Error('Generation cancelled');
 const connection=await db.getConnection();try{await saveDraftDefinitions(connection,job.sourceId,job.input.catalog.fingerprint,definitions);}finally{connection.release();}
 const result={count:definitions.length,genericCount:definitions.filter(t=>t.name.startsWith('schema_')).length,aiCount:definitions.filter(t=>!t.name.startsWith('schema_')).length};
 await updateJob(workspaceId,jobId,current=>mine(current)?{...current,status:'completed',progress:'Validated drafts saved',result,heartbeatAt:Date.now()}:null);
}catch(error){if(owned)await updateJob(workspaceId,jobId,current=>mine(current)?{...current,status:'failed',error:error instanceof Error?error.message:'Generation failed',progress:'Stopped; completed schema groups kept for retry'}:null).catch(()=>{});}
finally{clearInterval(heartbeat);await db.end();}
