// Streaming, whole-customer-base CSV export.
//
// WHY THIS EXISTS SEPARATELY FROM THE CHAT/REPORT FLOW: "give me a report
// for every customer" (or any count so large it really means "all of
// them", e.g. "top 2,000,000 customers") cannot be answered by embedding
// every row in the chat JSON response, holding them in React state, and
// building an .xlsx client-side (see chat-workspace.tsx's
// handleExportArtifact) -- that path is fine for a bounded top-N report,
// but it would try to hold the whole customer base in browser memory and
// in one HTTP response body. This route is the correct path for that
// instead: it reads via a real server-side Postgres CURSOR
// (streamAllCustomerFinancials, revenueService.mjs) and writes CSV rows to
// the HTTP response AS THEY ARRIVE, so memory use here stays flat
// (one batch's worth) no matter whether the customer base is 386 rows or
// 38,600,000. CSV, not .xlsx, on purpose -- Excel itself caps a single
// sheet at 1,048,576 rows, so a true "every customer" export needs a
// format with no row ceiling; CSV opens in Excel/Sheets fine regardless of
// size.
//
// This is deliberately its own route, not a `format=csv` flag on the
// existing chat artifact export -- that export always has the full row
// set already in the browser (it's building the file FROM data already on
// screen); this route never assumes that and always re-queries fresh.
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
// The bi-warehouse services layer is plain, untyped .mjs (every other
// consumer of it -- dashboard-data.mjs, agent.mjs -- is itself .mjs, so
// this is the first time a .ts file has imported it directly). Rather than
// let it silently type as `any` throughout this file, its actual real
// shape is declared once here.
import { streamAllCustomerFinancials as streamAllCustomerFinancialsUntyped } from '../../../../../bi-warehouse/src/services/revenueService.mjs';

type CustomerFinancialsRow = {
  customerId: string;
  customerName: string | null;
  popId: string | null;
  packageId: string | null;
  packageName: string | null;
  billed: number;
  collected: number;
  refunded: number;
  adjusted: number;
  outstanding: number;
};

const streamAllCustomerFinancials = streamAllCustomerFinancialsUntyped as (
  args: { dateFrom?: string; dateTo?: string },
  onBatch: (rows: CustomerFinancialsRow[]) => Promise<void> | void,
) => Promise<{ totalRows: number }>;

export const runtime = 'nodejs';
// A full-base export can genuinely take a while at real scale -- this is a
// background download, not an interactive chat reply, so it gets real
// headroom rather than the chat API's own tight timeout.
export const maxDuration = 300;

const CSV_HEADERS = [
  'Customer ID',
  'Customer Name',
  'POP ID',
  'Package ID',
  'Package Name',
  'Total Billed',
  'Total Collected',
  'Total Refunded',
  'Total Adjusted',
  'Outstanding',
];

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Real CSV quoting: only wrap in quotes when the field actually contains
  // something that would otherwise break column boundaries or line
  // boundaries, and double any embedded quote -- the standard CSV escape,
  // not a custom one, so this opens correctly in Excel/Sheets/any real CSV
  // reader.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',') + '\r\n';
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response('Sign in to export data.', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const dateFrom = searchParams.get('dateFrom') || undefined;
  const dateTo = searchParams.get('dateTo') || undefined;

  const encoder = new TextEncoder();
  let totalRows = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvRow(CSV_HEADERS)));
        const { totalRows: rowCount } = await streamAllCustomerFinancials({ dateFrom, dateTo }, async (batch) => {
          let chunk = '';
          for (const row of batch) {
            chunk += csvRow([
              row.customerId,
              row.customerName,
              row.popId,
              row.packageId,
              row.packageName,
              row.billed,
              row.collected,
              row.refunded,
              row.adjusted,
              row.outstanding,
            ]);
          }
          controller.enqueue(encoder.encode(chunk));
        });
        totalRows = rowCount;
        console.log(`[api/exports/customers] streamed ${totalRows} customer rows`);
        controller.close();
      } catch (error) {
        console.error('[api/exports/customers] stream failed:', error);
        // The header row (and possibly several data batches) may already
        // be flushed to the client by this point -- there is no clean way
        // to turn that into an HTTP error status anymore, so the stream is
        // simply torn down; a truncated file is an honest signal something
        // went wrong, better than one that silently looks complete.
        controller.error(error);
      }
    },
  });

  // Best-effort export-history log, same table the chat/report exports
  // already use -- file_content is left NULL on purpose (that column is
  // fine for a bounded chat-artifact .xlsx, not for a whole-customer-base
  // CSV that could be tens of MB; the row itself, with file_name/format/
  // created_at, is what makes this show up on the Exports page). Logged
  // fire-and-forget so a logging hiccup never blocks or fails the actual
  // download.
  const fileName = `all-customers-${new Date().toISOString().slice(0, 10)}.csv`;
  getAppDb()
    .execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [
      user.id,
      null,
      fileName,
      'csv',
      null,
    ])
    .catch((error) => console.error('[api/exports/customers] history log failed:', error));

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      // Never cache a data export -- always a fresh query.
      'Cache-Control': 'no-store',
    },
  });
}
