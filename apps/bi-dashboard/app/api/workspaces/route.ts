// Workspace list/create -- the entry point for onboarding a new customer
// database alongside the existing (hardcoded, untouched) ISP system. Every
// route under app/api/workspaces/* requires a signed-in user, same as the
// rest of the authenticated API surface (reports, exports, chat).
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { listWorkspaces, createWorkspace } from '@/lib/workspaces/workspaceDb';

const CreateWorkspaceSchema = z.object({ name: z.string().min(1).max(200) });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const workspaces = await listWorkspaces(user.id);
  return NextResponse.json({ workspaces });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = CreateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const workspace = await createWorkspace(parsed.data.name, user.id);
  return NextResponse.json({ workspace }, { status: 201 });
}
