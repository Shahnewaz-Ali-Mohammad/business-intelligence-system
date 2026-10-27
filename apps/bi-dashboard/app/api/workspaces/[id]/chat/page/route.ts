import { enterAccess } from '@/lib/access/data-scope.mjs';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {getCurrentUser} from '@/lib/auth/session';
import {getWorkspace} from '@/lib/workspaces/workspaceDb';
import {getTool,getSource} from '@/lib/tool-setup/store';
import {discoverDatabase,executeTool} from '@/lib/tool-setup/connectors.mjs';
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;const guard = await requireAccess('chat.use'); if (denied(guard)) return guard; enterAccess(guard.access); const user = guard.user;const workspace=user&&await getWorkspace(id);
  if(!user||!(await canOpenWorkspace(guard.access, id)))return NextResponse.json({error:'Workspace unavailable.'},{status:403});
  const parsed=z.object({toolId:z.string(),query:z.string().max(20000),page:z.number().int().min(1).max(10001)}).strict().safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid page request.'},{status:400});
  try{const tool=await getTool(id,parsed.data.toolId);if(tool.status!=='approved')throw new Error('Unavailable');
    const source=await getSource(id,tool.source_id);const catalog=await discoverDatabase(source.config);
    if(catalog.fingerprint!==tool.catalog_fingerprint)throw new Error('Schema changed');
    const result=await executeTool(source.config,tool.definition,catalog,{query:parsed.data.query},100,(parsed.data.page-1)*100);
    return NextResponse.json(result);
  }catch{return NextResponse.json({error:'Could not load this page. Approval, schema or stable ordering may have changed.'},{status:502});}
}
