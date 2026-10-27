'use client';

import { useState } from 'react';
import { useAuth, can } from '@/components/auth/auth-provider';
import { UsersPanel } from './users-panel';
import { DepartmentsPanel } from './departments-panel';
import { WorkspacesPanel } from './workspaces-panel';
import { AuditPanel } from './audit-panel';

const TABS = [
  { id: 'users', label: 'Users', permission: 'users.manage' },
  { id: 'departments', label: 'Departments', permission: 'users.manage' },
  { id: 'workspaces', label: 'Workspace access', permission: 'users.manage' },
  { id: 'audit', label: 'Audit log', permission: 'audit.view' },
] as const;

export function AdminConsole() {
  const { user, loading } = useAuth();
  const tabs = TABS.filter((t) => can(user, t.permission));
  const [tab, setTab] = useState<string>('users');
  if (loading) return <p className="text-sm text-zinc-500">Loading...</p>;
  if (!tabs.length) return <p className="text-sm text-zinc-600">Your role does not include administration.</p>;
  const current = tabs.find((t) => t.id === tab)?.id || tabs[0].id;
  return (
    <div className="space-y-5">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-zinc-200">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${current === t.id ? 'border-rose-700 text-rose-800' : 'border-transparent text-zinc-500 hover:text-zinc-800'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {current === 'users' && <UsersPanel />}
      {current === 'departments' && <DepartmentsPanel />}
      {current === 'workspaces' && <WorkspacesPanel />}
      {current === 'audit' && <AuditPanel />}
    </div>
  );
}
