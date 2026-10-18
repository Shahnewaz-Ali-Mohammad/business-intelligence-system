import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { listNotifications, markNotificationsRead } from '@/lib/schedules/notifications.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ items: [], unread: 0 });
  return NextResponse.json(await listNotifications(user.id));
}

/** Marks every notification as read. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  await markNotificationsRead(user.id);
  return NextResponse.json({ read: true });
}
