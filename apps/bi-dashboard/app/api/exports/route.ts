import { requireAccess, denied } from '@/lib/access/guard';
// Real export history: a row is written here only when a user actually
// clicks an Export button on a report. The row also stores the exported
// file's own content, so a later re-download from the Exports page always
// reproduces the exact file that was originally exported -- even if the
// source report is edited or deleted afterward. The /exports page reads
// this table and shows nothing until a real export has happened.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const guard = await requireAccess(); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ exports: [] });

  const db = getAppDb();
  const workspace = req.nextUrl.searchParams.get('workspace');
  const source = req.nextUrl.searchParams.get('source');
  const clauses = ['e.user_id=?'];
  const bindings: (string | number)[] = [user.id];
  if (!workspace || workspace === 'isp-default') clauses.push("(e.report_id IS NULL OR r.source_session_id IS NULL OR s.warehouse_id IS NULL OR s.warehouse_id='isp-default')");
  else { clauses.push('s.warehouse_id=?'); bindings.push(workspace); }
  if (source) { clauses.push("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.workspaceToolAnswer.sourceId'))=?"); bindings.push(source); }
  const [rows] = await db.execute(
    `SELECT e.id,e.report_id,e.file_name,e.format,e.created_at FROM report_exports e LEFT JOIN generated_reports r ON r.id=e.report_id AND r.user_id=e.user_id LEFT JOIN chat_sessions s ON s.id=r.source_session_id AND s.user_id=e.user_id WHERE ${clauses.join(' AND ')} ORDER BY e.created_at DESC LIMIT 100`,
    bindings,
  );
  return NextResponse.json({ exports: rows });
}

export async function POST(req: NextRequest) {
  const guard = await requireAccess('reports.export'); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ logged: false, reason: 'not logged in' });

  try {
    const { reportId, fileName, format, fileContent } = await req.json();
    if (typeof fileName !== 'string' || typeof format !== 'string' || typeof fileContent !== 'string') {
      return NextResponse.json({ error: 'fileName, format, and fileContent are required.' }, { status: 400 });
    }

    const db = getAppDb();
    if (reportId != null) {
      const [reports] = await db.execute('SELECT id FROM generated_reports WHERE id=? AND user_id=?', [reportId, user.id]);
      if (!(reports as unknown[]).length) return NextResponse.json({ error: 'Report unavailable.' }, { status: 403 });
    }
    const [result] = await db.execute(
      'INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)',
      [user.id, typeof reportId === 'number' ? reportId : null, fileName, format, fileContent],
    );
    return NextResponse.json({ logged: true, id: (result as { insertId: number }).insertId });
  } catch (error) {
    console.error('export log failed:', error);
    return NextResponse.json({ error: 'Could not log export.' }, { status: 500 });
  }
}
