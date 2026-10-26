import { NextResponse } from 'next/server';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { loadAccess, type Access } from './access-db';
import { enterAccess, AccessDenied } from './data-scope.mjs';

export type Guarded = { user: SessionUser; access: Access };

/**
 * The single check every API route starts with: signed in, account active,
 * and holding `permission` (when given). On success the person's data scope
 * is attached to the rest of the request, so every query it runs is filtered.
 * Returns a ready error response otherwise.
 */
export async function requireAccess(permission?: string | string[]): Promise<Guarded | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  const access = await loadAccess(user.id);
  const needed = permission == null ? [] : Array.isArray(permission) ? permission : [permission];
  if (needed.some((p) => !access.permissions.includes(p)))
    return NextResponse.json({ error: 'Your role does not allow this.' }, { status: 403 });
  enterAccess(access);
  return { user, access };
}

export const denied = (result: Guarded | NextResponse): result is NextResponse => result instanceof NextResponse;

/** Turns a refused query into a clear 403 instead of a generic failure. */
export function accessError(error: unknown) {
  return error instanceof AccessDenied ? NextResponse.json({ error: error.message, code: 'access_denied' }, { status: 403 }) : null;
}

/** Workspaces are shared across the organisation; data roles and admins can open them. */
export function canOpenWorkspace(access: Access) {
  return access.dataRole || access.permissions.includes('setup.manage');
}
