import {mkdir,open,readFile,readdir,rename,unlink,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.env.BI_GENERATION_JOB_DIR||fileURLToPath(new URL('../../.data/generation-jobs/',import.meta.url));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function directory(workspace){if(!uuid.test(workspace))throw new Error('Invalid workspace.');return path.join(root,workspace);}
function file(workspace,id){if(!uuid.test(id))throw new Error('Invalid generation job.');return path.join(directory(workspace),id+'.json');}
async function lock(workspace,work){
 const dir=directory(workspace);await mkdir(dir,{recursive:true,mode:0o700});const name=path.join(dir,'.lock');
 let handle;
 for(let i=0;i<200;i++){
  try{handle=await open(name,'wx',0o600);break;}catch(error){
   if(error.code!=='EEXIST')throw error;
   const info=await stat(name).catch(()=>null);if(info&&Date.now()-info.mtimeMs>30000)await unlink(name).catch(()=>{});
   await new Promise(resolve=>setTimeout(resolve,25));
  }
 }
 if(!handle)throw new Error('Generation status storage is busy. Please retry.');
 try{return await work();}finally{await handle.close();await unlink(name).catch(()=>{});}
}
async function writeJob(workspace,job){
 const target=file(workspace,job.id);const temporary=target+'.'+crypto.randomUUID()+'.tmp';
 const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(job));await handle.sync();}finally{await handle.close();}
 await rename(temporary,target);
}
export async function readJob(workspace,id){try{return JSON.parse(await readFile(file(workspace,id),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function latestJob(workspace,source){
 if(!uuid.test(source))throw new Error('Invalid database.');
 const files=await readdir(directory(workspace)).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 const jobs=await Promise.all(files.filter(name=>uuid.test(name.replace(/\.json$/,''))).map(name=>readJob(workspace,name.slice(0,-5))));
 return jobs.filter(job=>job?.sourceId===source).sort((a,b)=>b.createdAt-a.createdAt)[0]||null;
}
export async function updateJob(workspace,id,update){return lock(workspace,async()=>{
 const job=await readJob(workspace,id);if(!job)return null;const next=update(job);if(!next)return null;
 next.updatedAt=Date.now();await writeJob(workspace,next);return next;
});}
export async function createJob(workspace,source,input){return lock(workspace,async()=>{
 const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');const latest=await latestJob(workspace,source);
 if(latest&&['queued','running'].includes(latest.status)){if(latest.inputHash!==digest)throw new Error('Generation is already running for this database. Wait or cancel it before changing the selection.');return latest;}
 if(latest&&['failed','cancelled'].includes(latest.status)&&latest.inputHash===digest){
  latest.status='queued';latest.error=null;latest.workerPid=null;latest.progress='Resuming completed schema groups';latest.updatedAt=Date.now();await writeJob(workspace,latest);return latest;
 }
 const job={id:crypto.randomUUID(),workspaceId:workspace,sourceId:source,inputHash:digest,input,status:'queued',progress:'Queued',checkpoints:{},result:null,error:null,workerPid:null,heartbeatAt:null,createdAt:Date.now(),updatedAt:Date.now()};
 await writeJob(workspace,job);return job;
});}
