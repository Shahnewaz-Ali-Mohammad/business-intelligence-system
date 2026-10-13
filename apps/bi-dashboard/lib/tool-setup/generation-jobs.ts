import path from 'node:path';
import {spawn} from 'node:child_process';
import {getSource,getSourceNotes,saveSourceNotes} from './store';
import {profileCodeColumns,draftBusinessNotes} from './business-notes.mjs';
import {createJob,readJob,latestJob,updateJob} from './generation-job-store.mjs';
type SavedJob = {status:string;heartbeatAt?:number|null;[key:string]:unknown};

export function launchWorker(workspaceId:string,jobId:string) {
 const worker=spawn(process.execPath,[path.join(process.cwd(),'scripts/generate-tools-worker.mjs'),workspaceId,jobId],{cwd:process.cwd(),env:process.env,detached:true,stdio:'ignore'});
 worker.on('error',()=>{void updateJob(workspaceId,jobId,(job: SavedJob)=>job.status==='queued'?{...job,status:'failed',error:'Could not start generation worker.'}:null);});worker.unref();
}
export async function startGeneration(workspaceId:string,input:{sourceId:string;selected:{id:string;columns:string[]}[];request:string}){
 const source=await getSource(workspaceId,input.sourceId);
 let notes=await getSourceNotes(input.sourceId);
 // No notes yet: draft them automatically from the schema and code values,
 // save them for the owner to review and edit, and use them for this run.
 if(!notes.trim()){
  try{
   const objectIds=input.selected.map((s)=>s.id);
   const profiles=await profileCodeColumns(source.config,source.catalog,objectIds).catch(()=>[]);
   notes=await draftBusinessNotes({catalog:source.catalog,profiles,objectIds});
   if(notes)await saveSourceNotes(workspaceId,input.sourceId,notes);
  }catch(error){console.error('[tool generation] notes draft skipped:',error instanceof Error?error.message:error);}
 }
 const job=await createJob(workspaceId,input.sourceId,{catalog:source.catalog,selected:input.selected,request:input.request,notes});
 launchWorker(workspaceId,job.id);return {jobId:job.id};
}
export async function generationStatus(workspaceId:string,jobId?:string,sourceId?:string){
 let job=jobId?await readJob(workspaceId,jobId):sourceId?await latestJob(workspaceId,sourceId):null;
 if(!job)return null;
 if(job.status==='running'&&Date.now()-(job.heartbeatAt||0)>60000){job=await updateJob(workspaceId,job.id,(current:SavedJob)=>current.status==='running'&&Date.now()-(current.heartbeatAt||0)>60000?{...current,status:'queued',workerPid:null}:current);}
 if(job.status==='queued')launchWorker(workspaceId,job.id);
 return {jobId:job.id,status:job.status,progress:job.progress,error:job.error,result:job.result,startedAt:job.createdAt};
}
export async function cancelGeneration(workspaceId:string,jobId:string){
 await updateJob(workspaceId,jobId,(job:SavedJob)=>['queued','running'].includes(job.status)?{...job,status:'cancelled',progress:'Cancelled; completed work kept for retry'}:job);
 return {cancelled:true};
}

export async function resumeGeneration(workspaceId:string,jobId:string){
 const job=await readJob(workspaceId,jobId);if(!job)throw new Error('Generation job unavailable.');
 const source=await getSource(workspaceId,job.sourceId);
 if(source.catalog.fingerprint!==job.input.catalog.fingerprint)throw new Error('The schema changed. Select the current fields and generate again.');
 const resumed=await createJob(workspaceId,job.sourceId,job.input);launchWorker(workspaceId,resumed.id);return {jobId:resumed.id};
}
