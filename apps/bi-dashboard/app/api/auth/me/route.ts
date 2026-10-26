import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { loadAccess } from '@/lib/access/access-db';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null });
  const access = await loadAccess(user.id);
  return NextResponse.json({ user: { ...user, roles: access.roles, permissions: access.mfaSetupRequired ? [] : access.permissions, departments: access.departmentNames, mfaSetupRequired: !!access.mfaSetupRequired, accessInstalled: !access.notInstalled } });
}
