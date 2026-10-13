export function isLengthLimit(error){return /length limit|length.*reached|finish_reason.*length|maximum.*output|LengthFinishReason/i.test(String(error?.message||error?.name||''));}
export async function withOutputRecovery(invoke,onProgress){
 for(const budget of [32768,65536]){
  try{return await invoke(budget);}
  catch(error){if(!isLengthLimit(error)||budget===65536)throw error;await onProgress?.('The model response reached its length limit; retrying this group with more output space. Completed groups are kept.');}
 }
}
