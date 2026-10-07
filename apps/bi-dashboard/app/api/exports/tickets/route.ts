// Whole-ticket-list .xlsx export. FIX 2026-10-04: this route was first
// built as a streamed CSV -- wrong call. This app has an explicit,
// existing rule (see lib/download.ts's own header comment): "Excel-only,
// by design -- no CSV anywhere in this app." CSV also meant this export
// lived SEPARATELY from the real "Export Excel" button instead of being
// what that button actually does for a ticket_list report, which is the
// behavior that was actually asked for: Export Excel must export every
// row, not just the 5,000 already loaded on screen.
//
// Still re-queries fresh via the real server-side Postgres CURSOR
// (streamAllTickets, ticketService.mjs) rather than trusting whatever's
// already loaded in the browser -- that part of the original design was
// right and is kept. The cursor keeps DB-side memory flat in batches;
// rows accumulate into one in-memory array here before being written to
// a single .xlsx workbook (the `xlsx` package has no true streaming
// writer), which is a real, bounded cost but a safe one at this system's
// actual scale (currently ~173k tickets -- xlsx's own per-sheet row
// ceiling is 1,048,576, so this has real headroom before it would ever
// need a different approach).
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { streamAllTickets as streamAllTicketsUntyped } from '../../../../../bi-warehouse/src/services/ticketService.mjs';

type TicketRow = {
  ticket_sk: string | number;
  source_ticket_id: string | number | null;
  customer_id: string | number | null;
  department_id: string | number | null;
  ticket_type_id: string | number | null;
  ticket_type_name: string | null;
  opened_date: string | null;
  resolved_date: string | null;
  status: string | number | null;
};

const streamAllTickets = streamAllTicketsUntyped as (
  args: { ticketTypeId?: string; departmentId?: string; status?: string; dateFrom?: string; dateTo?: string },
  onBatch: (rows: TicketRow[]) => Promise<void> | void,
) => Promise<{ totalRows: number }>;

export const runtime = 'nodejs';
export const maxDuration = 300;

const HEADERS = [
  'Ticket ID',
  'Customer ID',
  'Department ID',
  'Ticket Type ID',
  'Ticket Type Name',
  'Opened Date',
  'Resolved Date',
  'Status',
];

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response('Sign in to export data.', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const ticketTypeId = searchParams.get('ticketTypeId') || undefined;
  const departmentId = searchParams.get('departmentId') || undefined;
  const status = searchParams.get('status') || undefined;
  const dateFrom = searchParams.get('dateFrom') || undefined;
  const dateTo = searchParams.get('dateTo') || undefined;

  const aoa: (string | number | null)[][] = [HEADERS];
  try {
    await streamAllTickets({ ticketTypeId, departmentId, status, dateFrom, dateTo }, (batch) => {
      for (const row of batch) {
        aoa.push([
          row.source_ticket_id ?? row.ticket_sk,
          row.customer_id,
          row.department_id,
          row.ticket_type_id,
          row.ticket_type_name,
          row.opened_date,
          row.resolved_date,
          row.status,
        ]);
      }
    });
  } catch (error) {
    console.error('[api/exports/tickets] query failed:', error);
    return NextResponse.json({ error: 'Could not build the full ticket export.' }, { status: 500 });
  }

  const totalRows = aoa.length - 1;
  console.log(`[api/exports/tickets] built xlsx with ${totalRows} ticket rows`);

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'All Tickets');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const fileName = `all-tickets-${new Date().toISOString().slice(0, 10)}.xlsx`;
  getAppDb()
    .execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [
      user.id,
      null,
      fileName,
      'xlsx',
      null,
    ])
    .catch((error) => console.error('[api/exports/tickets] history log failed:', error));

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
