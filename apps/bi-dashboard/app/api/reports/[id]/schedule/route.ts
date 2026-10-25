import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { cleanSchedule, nextRunAt, describeSchedule } from '@/lib/schedules/schedule-time.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

async function ownedReport(id: string, userId: number) {
  const [rows] = await getAppDb().execute("SELECT id, JSON_EXTRACT(data, '$.schedule') AS schedule, COALESCE(JSON_EXTRACT(data, '$.workspaceToolAnswer.workspaceId'), IF(JSON_EXTRACT(data, '$.ispQuestion.question') IS NULL, NULL, 'isp-default')) AS workspaceId, JSON_EXTRACT(data, '$.scheduledFrom') AS scheduledFrom FROM generated_reports WHERE id=? AND user_id=?", [id, userId]);
  return (rows as { id: number; schedule: unknown; workspaceId: unknown; scheduledFrom: unknown }[])[0] || null;
}
const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  const report = await ownedReport((await params).id, user.id);
  if (!report) return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
  const schedule = parse(report.schedule);
  return NextResponse.json({ schedulable: !!report.workspaceId && !report.scheduledFrom, schedule: schedule || null, description: schedule ? describeSchedule(schedule) : null });
}

/** Sets, changes or turns off a report's schedule. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  const { id } = await params;
  const report = await ownedReport(id, user.id);
  if (!report) return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
  if (!report.workspaceId || report.scheduledFrom) return NextResponse.json({ error: 'This report has no saved question or query to run again.' }, { status: 400 });
  try {
    const body = await req.json();
    const previous = parse(report.schedule) || {};
    const schedule = cleanSchedule(body);
    const saved = { ...previous, ...schedule, nextRunAt: schedule.enabled ? nextRunAt(schedule) : null };
    await getAppDb().execute("UPDATE generated_reports SET data=JSON_SET(data, '$.schedule', JSON_EXTRACT(?, '$')) WHERE id=? AND user_id=?", [JSON.stringify(saved), id, user.id]);
    return NextResponse.json({ schedule: saved, description: describeSchedule(saved) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid schedule.' }, { status: 400 }); }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  await getAppDb().execute("UPDATE generated_reports SET data=JSON_REMOVE(data, '$.schedule') WHERE id=? AND user_id=? AND JSON_EXTRACT(data, '$.schedule') IS NOT NULL", [(await params).id, user.id]);
  return NextResponse.json({ removed: true });
}
