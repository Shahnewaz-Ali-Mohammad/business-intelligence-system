'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, UserPlus } from 'lucide-react';
import { inputClass, buttonClass, ghostClass, post } from './admin-ui';

type Role = { name: string; label: string; description: string };
type Department = { id: number; name: string; parentId: number | null };
type User = { id: number; email: string; displayName: string | null; disabledAt: string | null; lastSignIn: string | null; roles: string[]; departmentIds: number[] };
type Invite = { id: number; email: string; roles: string[]; departmentIds: number[]; expiresAt: string };
type Data = { users: User[]; invitations: Invite[]; roles: Role[]; departments: Department[]; me: number };

const needsDepartment = (roles: string[]) => roles.some((r) => r === 'manager' || r === 'executive');

/** Roles and departments for one person (used for invites and edits). */
function AccessPicker({ data, roles, departments, onRoles, onDepartments }: { data: Data; roles: string[]; departments: number[]; onRoles: (r: string[]) => void; onDepartments: (d: number[]) => void }) {
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {data.roles.map((role) => (
          <label key={role.name} title={role.description} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={roles.includes(role.name)} onChange={() => onRoles(toggle(roles, role.name))} />{role.label}
          </label>
        ))}
      </div>
      {needsDepartment(roles) && (
        <div className="flex flex-wrap gap-3">
          {data.departments.length ? data.departments.map((d) => (
            <label key={d.id} className="flex items-center gap-1.5 text-sm text-zinc-700">
              <input type="checkbox" checked={departments.includes(d.id)} onChange={() => onDepartments(toggle(departments, d.id))} />{d.name}
            </label>
          )) : <span className="text-xs text-amber-700">Create departments first (Departments tab).</span>}
        </div>
      )}
    </div>
  );
}

export function UsersPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['executive']);
  const [departments, setDepartments] = useState<number[]>([]);
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState<{ id: number; roles: string[]; departments: number[] } | null>(null);

  const load = useCallback(() => fetch('/api/admin/users').then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  async function run(body: unknown, done?: (result: { inviteLink?: string }) => void) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await post('/api/admin/users', body); done?.(result); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  if (!data) return <p className="text-sm text-zinc-500">{error || 'Loading...'}</p>;
  const roleLabel = (name: string) => data.roles.find((r) => r.name === name)?.label || name;
  const deptNames = (ids: number[]) => ids.map((id) => data.departments.find((d) => d.id === id)?.name).filter(Boolean).join(', ');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-800"><UserPlus size={16} />Invite a person</h2>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run({ action: 'invite', email, roles, departmentIds: needsDepartment(roles) ? departments : [] }, (r) => { setLink(r.inviteLink || ''); setEmail(''); }); }}>
          <input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputClass} w-full max-w-sm`} />
          <AccessPicker data={data} roles={roles} departments={departments} onRoles={setRoles} onDepartments={setDepartments} />
          <button className={buttonClass} disabled={busy || !roles.length}>Create invite link</button>
        </form>
        {link && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
            <p className="mb-1 text-emerald-800">Send this link to the person. It works once and expires in 7 days; it is not shown again.</p>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{link}</code>
              <button type="button" className={ghostClass} onClick={() => { void navigator.clipboard?.writeText(link); setNotice('Link copied.'); }}><Copy size={12} />Copy</button></div>
          </div>
        )}
      </section>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-800">People</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500"><tr><th className="px-3 py-2">Person</th><th className="px-3 py-2">Roles</th><th className="px-3 py-2">Departments</th><th className="px-3 py-2">Last sign-in</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={`border-t border-zinc-100 align-top ${u.disabledAt ? 'text-zinc-400' : ''}`}>
                  <td className="px-3 py-2"><div className="font-medium">{u.displayName || u.email}</div>{u.displayName && <div className="text-xs text-zinc-500">{u.email}</div>}{u.disabledAt && <div className="text-xs text-red-600">Disabled</div>}</td>
                  {editing?.id === u.id ? (
                    <td colSpan={3} className="px-3 py-2">
                      <AccessPicker data={data} roles={editing.roles} departments={editing.departments} onRoles={(r) => setEditing({ ...editing, roles: r })} onDepartments={(d) => setEditing({ ...editing, departments: d })} />
                      <div className="mt-2 flex gap-2">
                        <button className={buttonClass} disabled={busy || !editing.roles.length} onClick={() => void run({ action: 'update', userId: u.id, roles: editing.roles, departmentIds: needsDepartment(editing.roles) ? editing.departments : [] }, () => { setEditing(null); setNotice('Access updated. It applies from their next click.'); })}>Save</button>
                        <button className={ghostClass} onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2">{u.roles.map(roleLabel).join(', ') || <span className="text-amber-700">No role</span>}</td>
                      <td className="px-3 py-2">{deptNames(u.departmentIds) || (u.roles.includes('ceo') ? 'All' : '—')}</td>
                      <td className="px-3 py-2 text-xs">{u.lastSignIn ? new Date(u.lastSignIn).toLocaleString() : 'Never'}</td>
                    </>
                  )}
                  <td className="px-3 py-2 text-right">
                    {editing?.id !== u.id && <div className="flex justify-end gap-1">
                      <button className={ghostClass} disabled={busy} onClick={() => setEditing({ id: u.id, roles: u.roles, departments: u.departmentIds })}>Edit access</button>
                      {u.id !== data.me && <button className={ghostClass} disabled={busy} onClick={() => { if (u.disabledAt || window.confirm(`Disable ${u.email}? They are signed out everywhere immediately.`)) void run({ action: u.disabledAt ? 'enable' : 'disable', userId: u.id }); }}>{u.disabledAt ? 'Enable' : 'Disable'}</button>}
                    </div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.invitations.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-800">Open invitations</h2>
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white text-sm">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>{i.email} · {i.roles.map(roleLabel).join(', ')}{i.departmentIds.length ? ` · ${deptNames(i.departmentIds)}` : ''} · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                <button className={ghostClass} disabled={busy} onClick={() => void run({ action: 'revokeInvite', inviteId: i.id })}>Revoke</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="text-xs text-zinc-500">
        {data.roles.map((r) => <p key={r.name}><b>{r.label}:</b> {r.description}</p>)}
      </section>
    </div>
  );
}
