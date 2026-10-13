import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const dir=await mkdtemp(path.join(tmpdir(),'bi-generation-jobs-'));
process.env.BI_GENERATION_JOB_DIR=dir;
const {createJob,readJob,latestJob,updateJob}=await import('./generation-job-store.mjs');
after(async()=>{await rm(dir,{recursive:true,force:true});});
test('saved progress and completed batches survive reopening and retry',async()=>{
 const workspace=randomUUID(),source=randomUUID(),input={catalog:{fingerprint:'test'},selected:[],request:''};
 const job=await createJob(workspace,source,input);
 await updateJob(workspace,job.id,current=>({...current,status:'cancelled',checkpoints:{0:[{name:'customer_details'}]},progress:'Cancelled'}));
 const reopened=await latestJob(workspace,source);assert.equal(reopened.checkpoints[0][0].name,'customer_details');
 const resumed=await createJob(workspace,source,input);assert.equal(resumed.id,job.id);assert.equal(resumed.status,'queued');assert.deepEqual(resumed.checkpoints,reopened.checkpoints);
});
test('concurrent claims start only one worker and updates preserve checkpoints',async()=>{
 const workspace=randomUUID(),job=await createJob(workspace,randomUUID(),{});
 const claims=await Promise.all([1,2].map(pid=>updateJob(workspace,job.id,current=>current.status==='queued'?{...current,status:'running',workerPid:pid}:null)));
 assert.equal(claims.filter(Boolean).length,1);
 await Promise.all([0,1].map(index=>updateJob(workspace,job.id,current=>({...current,checkpoints:{...current.checkpoints,[index]:['done']}}))));
 assert.equal(Object.keys((await readJob(workspace,job.id)).checkpoints).length,2);
});
test('changed selections do not silently reuse another active job',async()=>{
 const workspace=randomUUID(),source=randomUUID();await createJob(workspace,source,{selected:['customers']});
 await assert.rejects(createJob(workspace,source,{selected:['billing']}),/already running/);
 await assert.rejects(readJob(workspace,'../../private'),/Invalid generation job/);
});
test('separate worker persists failure without a database query or model request',async()=>{
 const workspace=randomUUID(),input={catalog:{objects:[],relationships:[],fingerprint:'synthetic'},selected:[{id:'missing',columns:['Example']}],request:''};
 const job=await createJob(workspace,randomUUID(),input);
 const workerPath=new URL('../../scripts/generate-tools-worker.mjs',import.meta.url);
 const run=()=>new Promise((resolve,reject)=>{const worker=spawn(process.execPath,[fileURLToPath(workerPath),workspace,job.id],{env:process.env,stdio:'ignore'});worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(new Error('Worker failed to start')));});
 await Promise.all([run(),run()]);
 const result=await readJob(workspace,job.id);assert.equal(result.status,'failed');assert.match(result.error,/Select available tables/);assert.deepEqual(result.checkpoints,{});
});

test('a healthy saved job is not expired merely because it passed four minutes',async()=>{
 const workspace=randomUUID(),source=randomUUID();const job=await createJob(workspace,source,{});
 await updateJob(workspace,job.id,current=>({...current,status:'running',workerPid:123,createdAt:Date.now()-600000,heartbeatAt:Date.now()}));
 assert.equal((await latestJob(workspace,source)).status,'running');
});
