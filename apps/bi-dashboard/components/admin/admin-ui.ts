export const inputClass = 'h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100';
export const buttonClass = 'inline-flex h-9 items-center gap-2 rounded-md bg-rose-700 px-3 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50';
export const ghostClass = 'inline-flex h-8 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50';

export async function post(url: string, body: unknown, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not save.');
  return data;
}
