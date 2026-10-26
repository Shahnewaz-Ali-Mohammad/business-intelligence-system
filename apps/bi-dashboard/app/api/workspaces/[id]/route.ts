import { enterAccess } from '@/lib/access/data-scope.mjs';
import { audit } from '@/lib/access/access-db';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import {getAppDb} from '@/lib/db/app-db';
// Single-workspace operations -- currently just delete. Kept separate from
// app/api/workspaces/route.ts (list/create) since that one has no [id]
// segment; Next's routing requires the split.
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, deleteWorkspace } from '@/lib/workspaces/workspaceDb';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAccess('setup.manage');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const user = guard.user;
  const { id: workspaceId } = await params;

  // The seeded row representing the existing, real ISP production system --
  // never deletable through this UI/API, regardless of who owns it. Deleting
  // it wouldn't touch any real ISP data (this table only holds onboarding
  // metadata), but it's a confusing, easy-to-regret click to allow.
  if (workspaceId === 'isp-default') {
    return NextResponse.json({ error: 'The existing ISP system cannot be removed from here.' }, { status: 400 });
  }

  const deleted = await deleteWorkspace(workspaceId);
  void audit(user.id, 'workspace.delete', workspaceId);
  if (!deleted) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return NextResponse.json({error:'Cross-origin request blocked.'},{status:403});
 const guard=await requireAccess('setup.manage');if(denied(guard))return guard;const user=guard.user;
 const {id}=await params;const workspace=await getWorkspace(id);
 if(!workspace||!canOpenWorkspace(guard.access)||id==='isp-default')return NextResponse.json({error:'Workspace unavailable.'},{status:403});
 const input=await request.json().catch(()=>null);const name=typeof input?.name==='string'?input.name.trim():'';
 if(!name||name.length>200)return NextResponse.json({error:'Enter a workspace name between 1 and 200 characters.'},{status:400});
 await getAppDb().execute('UPDATE workspaces SET name=? WHERE id=?',[name,id]);
 return NextResponse.json({id,name});
}
