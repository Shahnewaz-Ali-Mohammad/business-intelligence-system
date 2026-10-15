"use client";
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
export function MissingScenario({id,sourceId,question,gap,jobId:initialJobId,onRetry}:{id:string;sourceId:string;question:string;gap:string;jobId?:string;onRetry:(question:string)=>void}){
 const [jobId,setJobId]=useState<string|null>(initialJobId||null),[status,setStatus]=useState(''),[busy,setBusy]=useState(Boolean(initialJobId)),[done,setDone]=useState(false);
 useEffect(()=>{
  if(!jobId)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const check=async()=>{try{const response=await fetch(`/api/workspaces/${id}/tool-setup?generationJob=${encodeURIComponent(jobId)}`,{signal:controller.signal});const data=await response.json();if(!response.ok||!data.job)throw Error(data.error||'Generation status unavailable.');setStatus(data.job.error||data.job.progress);if(data.job.status==='completed'){setDone(true);setBusy(false);}else if(['failed','cancelled'].includes(data.job.status)){setBusy(false);}else timer=setTimeout(check,2000);}catch(e){if(!controller.signal.aborted){setStatus(e instanceof Error?e.message:'Could not check generation.');setBusy(false);}}};void check();return()=>{controller.abort();clearTimeout(timer);};
 },[id,jobId]);
 async function generate(){setJobId(null);setBusy(true);setStatus('Preparing the missing report');try{const response=await fetch(`/api/workspaces/${id}/tool-setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'generateMissing',sourceId,question,gap,consent:true})});const data=await response.json();if(!response.ok)throw Error(data.error||'Could not generate the report.');setJobId(data.jobId);}catch(e){setStatus(e instanceof Error?e.message:'Generation failed.');setBusy(false);}}
 return <div className="rounded-xl border bg-white p-4 space-y-3"><p className="text-sm text-zinc-600">{gap}</p><p className="text-xs text-zinc-500">Generate a reusable report using your selected schema and this question. Existing reports are preserved. Review and approve the draft before using it.</p><div className="flex gap-2"><Button onClick={generate} disabled={busy||done}>{busy?'Generating…':'Generate missing report'}</Button><a className="text-sm underline self-center" href={`/data-sources/${id}/tools`}>Review in Settings</a>{done&&<Button variant="outline" onClick={()=>onRetry(question)}>Retry question after approval</Button>}</div>{status&&<p role="status" className="text-sm">{status}</p>}</div>;
}
