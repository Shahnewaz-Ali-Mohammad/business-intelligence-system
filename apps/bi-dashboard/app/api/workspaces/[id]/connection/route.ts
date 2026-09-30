// Saves a workspace's source-database connection (encrypted at rest, see
// lib/workspaces/secrets.ts) and immediately runs schema introspection
// against it so the onboarding UI can show the customer's real schema
// right away, before any sync or AI drafting happens.
//
// Cross-package import into bi-warehouse mirrors the existing precedent in
// app/api/exports/customers/route.ts (which already imports
// bi-warehouse/src/services/revenueService.mjs the same way) -- this repo
// already treats bi-warehouse as a shared library, not something only
// reachable over HTTP. Turbopack's build root is widened to `apps/` in
// next.config.ts specifically so imports like this resolve.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, saveConnection } from '@/lib/workspaces/workspaceDb';
import { introspectPostgres } from '../../../../../../bi-warehouse/src/introspection/introspectPostgres.mjs';

const ConnectionSchema = z.object({
  dialect: z.literal('postgres'), // MySQL/SQL Server/Oracle: see introspectPostgres.mjs's header note -- not wired up yet
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  database: z.string().min(1),
  connectionString: z.string().min(1),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const { id: workspaceId } = await params;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.ownerUserId !== user.id) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = ConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { dialect, host, port, database, connectionString } = parsed.data;

  await saveConnection(workspaceId, dialect, host, port, database, connectionString);

  try {
    const introspection = await introspectPostgres(connectionString);
    return NextResponse.json({ ok: true, introspection });
  } catch (err) {
    // The connection itself is saved either way -- introspection failing
    // (bad credentials, firewall, etc.) shouldn't force the user to
    // re-enter everything, just to retry introspection once it's fixed.
    return NextResponse.json(
      { ok: true, introspection: null, introspectionError: err instanceof Error ? err.message : 'Introspection failed' },
      { status: 200 }
    );
  }
}
