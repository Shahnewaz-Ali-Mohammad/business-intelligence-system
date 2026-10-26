import { enterAccess } from '@/lib/access/data-scope.mjs';
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { requireAccess, denied } from '@/lib/access/guard';

export const runtime = 'nodejs';
const PAGE = 100;

/** Who did what, newest first. Filters: ?user=<email part> &action=<prefix> &page=. */
export async function GET(req: NextRequest) {
  const guard = await requireAccess('audit.view');
  if (denied(guard)) return guard; enterAccess(guard.access);
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const clauses: string[] = []; const values: string[] = [];
  const user = sp.get('user')?.trim(); const action = sp.get('action')?.trim();
  if (user) { clauses.push('u.email LIKE ?'); values.push(`%${user.replace(/[%_]/g, '')}%`); }
  if (action) { clauses.push('a.action LIKE ?'); values.push(`${action.replace(/[%_]/g, '')}%`); }
  const [rows] = await getAppDb().execute(
    `SELECT a.id, a.action, a.target, a.details, a.created_at, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`,
    values,
  );
  const list = rows as Record<string, unknown>[];
  return NextResponse.json({
    entries: list.slice(0, PAGE).map((r) => ({ id: r.id, action: r.action, target: r.target, details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details, at: r.created_at, user: r.email })),
    hasMore: list.length > PAGE, page,
  });
}
