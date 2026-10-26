import { requireAccess, denied } from '@/lib/access/guard';
// Persists generated report/artifact pages (chat intent "create_new_page")
// for the logged-in user.
import { NextRequest, NextResponse } from 'next/server';
import { getAppDb } from '@/lib/db/app-db';
import { getCurrentUser } from '@/lib/auth/session';
import { SAVE_ROW_CAP, capRowArraysForSave } from '@/lib/dashboard/report-save';

const PAGE_SIZE = 6; // standardized with Sessions list (was 5)

export async function GET(req: NextRequest) {
  const guard = await requireAccess(); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ reports: [], total: 0 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getAppDb();
  const workspace = req.nextUrl.searchParams.get('workspace');
  const source = req.nextUrl.searchParams.get('source');
  const clauses = ['r.user_id = ?'];
  const bindings: (string | number)[] = [user.id];
  if (!workspace || workspace === 'isp-default') {
    clauses.push("(r.source_session_id IS NULL OR EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=r.source_session_id AND s.user_id=r.user_id AND (s.warehouse_id IS NULL OR s.warehouse_id='isp-default')))");
  } else {
    clauses.push('EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=r.source_session_id AND s.user_id=r.user_id AND s.warehouse_id=?)');
    bindings.push(workspace);
  }
  if (source) {
    clauses.push("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.workspaceToolAnswer.sourceId'))=?");
    bindings.push(source);
  }
  const where = clauses.join(' AND ');
  const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM generated_reports r WHERE ${where}`, bindings);
  const total = Number((countRows as Array<{ total: number }>)[0]?.total ?? 0);

  const [rows] = await db.query(
    `SELECT r.id, r.title, r.narrative, r.topic, r.chart_type, r.chart_spec, r.created_at FROM generated_reports r WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...bindings, PAGE_SIZE, offset],
  );

  return NextResponse.json({ reports: rows, total, page, pageSize: PAGE_SIZE });
}

// FIX 2026-10-01: real bug -- Save Report serialized `data` whole, with
// no size awareness at all. For an aggregate breakdown (dozens of rows)
// that's trivial, but data.ticketList/customerList/semanticQueryTable.rows
// can now legitimately be up to 5,000 rows (see getTicketList's own
// comment), and stuffing a multi-thousand-row JSON blob into a single
// MySQL TEXT/JSON column on every save is exactly the kind of thing that
// makes saving feel slow or fail outright for no visible reason. A saved
// report is a snapshot for later reference, not the system's export
// mechanism (that's the dedicated CSV/Excel export, already unbounded and
// built for this) -- so this caps any row-array field in `data` at
// SAVE_ROW_CAP before it's ever written, walking every array property on
// `data` generically (not a per-topic list to maintain) so this applies
// uniformly to ticketList, customerList, semanticQueryTable.rows, or any
// future row-level field without another hand-written case.

export async function POST(req: NextRequest) {
  const guard = await requireAccess('reports.save'); if (denied(guard)) return guard; const user = guard.user;
  if (!user) return NextResponse.json({ saved: false, reason: 'not logged in' });

  try {
    const { title, narrative, topic, chartType, filters, tablesUsed, data, chartSpec, sourceSessionId } = await req.json();
    if (typeof title !== 'string' || typeof narrative !== 'string' || !data) {
      return NextResponse.json({ error: 'title, narrative, and data are required.' }, { status: 400 });
    }

    const { capped: cappedData, wasTruncated } = capRowArraysForSave(data);
    const finalNarrative = wasTruncated
      ? `${narrative}\n\n(This saved report's row-level data was capped at ${SAVE_ROW_CAP.toLocaleString()} rows to keep the saved snapshot fast to load. Use Export for the complete, unbounded data.)`
      : narrative;

    // sourceSessionId must actually belong to this user -- otherwise one
    // account could stitch its own report onto another account's chat
    // session id and get a "Continue in chat" link into someone else's
    // conversation. Verified with a real query instead of trusting the
    // client-supplied id outright.
    let verifiedSessionId: number | null = null;
    if (sourceSessionId != null) {
      const db0 = getAppDb();
      const [sessionRows] = await db0.execute('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?', [
        sourceSessionId,
        user.id,
      ]);
      verifiedSessionId = (sessionRows as Array<{ id: number }>)[0]?.id ?? null;
    }

    const db = getAppDb();
    const [result] = await db.execute(
      'INSERT INTO generated_reports (user_id, title, narrative, topic, chart_type, filters, tables_used, data, chart_spec, source_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        user.id,
        title,
        finalNarrative,
        typeof topic === 'string' ? topic : null,
        typeof chartType === 'string' ? chartType : null,
        filters ? JSON.stringify(filters) : null,
        tablesUsed ? JSON.stringify(tablesUsed) : null,
        JSON.stringify(cappedData),
        chartSpec ? JSON.stringify(chartSpec) : null,
        verifiedSessionId,
      ],
    );
    return NextResponse.json({ saved: true, id: (result as { insertId: number }).insertId, truncated: wasTruncated });
  } catch (error) {
    console.error('report save failed:', error);
    return NextResponse.json({ error: 'Could not save report.' }, { status: 500 });
  }
}
