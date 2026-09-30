// Runs the dlt sync (pysync/sync_workspace.py, open source, does the real
// work) for a workspace's saved connection. This route is pure glue: spawn
// the script, wait, record the outcome -- no sync logic lives here.
import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth/session';
import { getWorkspace, getConnection, recordSyncRun } from '@/lib/workspaces/workspaceDb';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  const { id: workspaceId } = await params;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.ownerUserId !== user.id) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }

  const connection = await getConnection(workspaceId);
  if (!connection) {
    return NextResponse.json({ error: 'No connection saved for this workspace yet.' }, { status: 404 });
  }

  const scriptPath = path.join(process.cwd(), '..', 'bi-warehouse', 'pysync', 'sync_workspace.py');
  const python = process.env.PYTHON_BIN || 'python3';

  const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(python, [scriptPath, workspaceId, connection.connectionString, connection.dialect], {
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message }));
  });

  if (!result.ok) {
    await recordSyncRun(workspaceId, 'failed', null, result.stderr || 'Sync failed');
    return NextResponse.json({ error: result.stderr || 'Sync failed' }, { status: 500 });
  }

  await recordSyncRun(workspaceId, 'succeeded', null, null);
  return NextResponse.json({ ok: true, output: result.stdout });
}
