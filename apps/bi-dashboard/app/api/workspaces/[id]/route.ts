// Single-workspace operations -- currently just delete. Kept separate from
// app/api/workspaces/route.ts (list/create) since that one has no [id]
// segment; Next's routing requires the split.
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { deleteWorkspace } from '@/lib/workspaces/workspaceDb';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const { id: workspaceId } = await params;

  // The seeded row representing the existing, real ISP production system --
  // never deletable through this UI/API, regardless of who owns it. Deleting
  // it wouldn't touch any real ISP data (this table only holds onboarding
  // metadata), but it's a confusing, easy-to-regret click to allow.
  if (workspaceId === 'isp-default') {
    return NextResponse.json({ error: 'The existing ISP system cannot be removed from here.' }, { status: 400 });
  }

  const deleted = await deleteWorkspace(workspaceId, user.id);
  if (!deleted) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
