import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';
import { Readable } from 'node:stream';
import { FILE_MARKER, openStoredExport } from '@/lib/exports/streaming-export.mjs';

export const runtime = 'nodejs';

/** ?download=1 sends the file itself; without it, the export record. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ export: null }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [rows] = await db.execute(
    'SELECT id, file_name, format, file_content FROM report_exports WHERE id = ? AND user_id = ?',
    [id, user.id],
  );
  const row = (rows as Array<{ id: number; file_name: string; format: string; file_content: string | null }>)[0];
  if (!row) return NextResponse.json({ export: null });
  if (req.nextUrl.searchParams.get('download') !== '1') {
    // Large exports are stored as files; the record never carries their bytes.
    const stored = typeof row.file_content === 'string' && row.file_content.startsWith(FILE_MARKER);
    return NextResponse.json({ export: { ...row, file_content: stored ? null : row.file_content, stored } });
  }
  const type = row.format === 'pdf' ? 'application/pdf' : row.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const headers = { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${row.file_name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store' };
  if (!row.file_content) return NextResponse.json({ error: 'This export file is no longer available.' }, { status: 404 });
  if (row.file_content.startsWith(FILE_MARKER)) {
    try {
      const file = await openStoredExport(row.file_content, row.format);
      return new NextResponse(Readable.toWeb(file.stream) as ReadableStream, { headers: { ...headers, 'Content-Length': String(file.size) } });
    } catch { return NextResponse.json({ error: 'This export file is no longer available.' }, { status: 404 }); }
  }
  return new NextResponse(new Uint8Array(Buffer.from(row.file_content, 'base64')), { headers });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ deleted: false, reason: 'not logged in' }, { status: 401 });

  const { id } = await params;
  const db = getAppDb();
  const [result] = await db.execute('DELETE FROM report_exports WHERE id = ? AND user_id = ?', [id, user.id]);
  const affected = (result as { affectedRows: number }).affectedRows;
  if (!affected) return NextResponse.json({ deleted: false }, { status: 404 });

  return NextResponse.json({ deleted: true });
}
