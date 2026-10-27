'use client';

import type { ReactNode } from 'react';
import { useAuth, can } from './auth-provider';
import { WorkspacePage } from '@/components/workspace/workspace-page';

/**
 * Shows a page only to people whose role allows it; everyone else gets a
 * plain explanation. (The server enforces the same permission on every call.)
 */
export function RequirePermission({ permission, children, message }: { permission: string; children: ReactNode; message?: string }) {
  const { user, loading } = useAuth();
  if (loading || !can(user, permission)) {
    // Shown inside the normal page frame, so the sidebar stays.
    return (
      <WorkspacePage active="" title="Not available" subtitle="" scroll>
        {loading ? <p className="text-sm text-zinc-500">Loading...</p> : (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            <p className="font-medium text-zinc-800">{message || 'Your role does not include this page.'}</p>
            <p className="mt-1">Ask your admin if you need it.</p>
          </div>
        )}
      </WorkspacePage>
    );
  }
  return <>{children}</>;
}
