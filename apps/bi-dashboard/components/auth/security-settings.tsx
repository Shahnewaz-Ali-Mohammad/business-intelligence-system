'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from './auth-provider';

type State = { enabled: boolean; required: boolean; secret?: string; url?: string };
const input = 'h-10 w-40 rounded-md border border-zinc-200 px-3 text-center text-lg tracking-[0.3em] outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100';
const button = 'inline-flex h-10 items-center rounded-md bg-rose-700 px-4 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50';

/** Turn two-step sign-in on (or off, when the role allows it). */
export function SecuritySettings() {
  const { user, refresh } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/mfa/setup').then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Two-step sign-in is not available yet.'); setState(d); }).catch((e) => setError(e.message));
  }, []);
  async function call(method: 'GET' | 'POST' | 'DELETE', body?: unknown) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/auth/mfa/setup${method === 'GET' ? '?start=1' : ''}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save.');
      setState((s) => ({ ...(s as State), ...d })); setCode('');
      if (method !== 'GET') await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (!state) return <p className="text-sm text-zinc-600">{error || 'Loading...'}</p>;
  return (
    <div className="max-w-xl space-y-4 rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-700">
      {user?.mfaSetupRequired && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">Your role (Admin or CEO) must use two-step sign-in. Set it up to continue.</p>}
      <p className="flex items-center gap-2 font-medium text-zinc-800"><ShieldCheck size={16} className="text-rose-700" />Two-step sign-in is {state.enabled ? 'on' : 'off'}.</p>
      {!state.enabled && !state.secret && (
        <button className={button} disabled={busy} onClick={() => void call('GET')}>Set up two-step sign-in</button>
      )}
      {!state.enabled && state.secret && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void call('POST', { code }); }}>
          <p>1. In Google Authenticator, Microsoft Authenticator or a similar app, add an account with this key (choose “Enter a setup key”, time-based):</p>
          <p className="break-all rounded-md bg-zinc-50 p-3 font-mono text-base tracking-wider text-zinc-900">{state.secret.match(/.{1,4}/g)?.join(' ')}</p>
          <p className="text-xs text-zinc-500">On a phone you can also open <a className="text-rose-700 underline" href={state.url}>this link</a> to add it directly. Keep the key private.</p>
          <p>2. Enter the 6-digit code the app shows:</p>
          <div className="flex gap-2">
            <input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className={button} disabled={busy || code.length !== 6}>Turn on</button>
          </div>
        </form>
      )}
      {state.enabled && (state.required ? <p className="text-zinc-500">Your role requires two-step sign-in, so it cannot be turned off. If you lose your phone, ask an admin to reset it.</p> : (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void call('DELETE', { code }); }}>
          <input className={input} inputMode="numeric" maxLength={6} placeholder="code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <button className={button} disabled={busy || code.length !== 6}>Turn off</button>
        </form>
      ))}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>
  );
}
