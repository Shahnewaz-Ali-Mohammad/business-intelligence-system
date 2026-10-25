import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { describeSchedule } from '@/lib/schedules/schedule-time.mjs';

export const runtime = 'nodejs';

/** The signed-in user's scheduled reports in this workspace (optionally one database). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ schedules: [] }, { status: 401 });
  const { id } = await params;
  const sourceId = req.nextUrl.searchParams.get('sourceId');
  // The original chat ("isp-default") schedules saved questions, not tool queries.
  const original = id === 'isp-default';
  const [rows] = await getAppDb().execute(
    "SELECT id, title, JSON_EXTRACT(data, '$.schedule') AS schedule FROM generated_reports WHERE user_id=? AND JSON_EXTRACT(data, '$.schedule') IS NOT NULL AND " +
      (original
        ? "JSON_EXTRACT(data, '$.ispQuestion.question') IS NOT NULL AND JSON_EXTRACT(data, '$.workspaceToolAnswer') IS NULL"
        : "JSON_UNQUOTE(JSON_EXTRACT(data, '$.workspaceToolAnswer.workspaceId'))=?" + (sourceId ? " AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.workspaceToolAnswer.sourceId'))=?" : '')) +
      ' ORDER BY id DESC LIMIT 100',
    original ? [user.id] : sourceId ? [user.id, id, sourceId] : [user.id, id],
  );
  return NextResponse.json({
    schedules: (rows as { id: number; title: string; schedule: unknown }[]).map((row) => {
      const schedule = typeof row.schedule === 'string' ? JSON.parse(row.schedule) : row.schedule;
      return { reportId: row.id, title: row.title, schedule, description: describeSchedule(schedule) };
    }),
  });
}
