// Whole-customer-base financials .xlsx export (top_customers/
// customer_summary topics). FIX 2026-10-04: same correction as
// app/api/exports/tickets and app/api/exports/customer-list -- this was
// originally built as CSV, which violates this app's own existing rule
// (lib/download.ts's header comment: "Excel-only, by design -- no CSV
// anywhere in this app"). Still re-queries fresh via the real server-side
// Postgres CURSOR (streamAllCustomerFinancials, revenueService.mjs)
// instead of trusting whatever's already loaded in the browser -- that
// part was always right. Rows accumulate into one in-memory array before
// being written to a single .xlsx workbook (the `xlsx` package has no
// true streaming writer); a real, bounded cost but safe at this system's
// actual customer-base scale, with real headroom before xlsx's own
// 1,048,576-row-per-sheet ceiling would ever matter.
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
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
export const maxDuration = 300;

const HEADERS = [
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

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response('Sign in to export data.', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const dateFrom = searchParams.get('dateFrom') || undefined;
  const dateTo = searchParams.get('dateTo') || undefined;

  const aoa: (string | number | null)[][] = [HEADERS];
  try {
    await streamAllCustomerFinancials({ dateFrom, dateTo }, (batch) => {
      for (const row of batch) {
        aoa.push([
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
    });
  } catch (error) {
    console.error('[api/exports/customers] query failed:', error);
    return NextResponse.json({ error: 'Could not build the full customer export.' }, { status: 500 });
  }

  const totalRows = aoa.length - 1;
  console.log(`[api/exports/customers] built xlsx with ${totalRows} customer rows`);

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'All Customers');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const fileName = `all-customers-financials-${new Date().toISOString().slice(0, 10)}.xlsx`;
  getAppDb()
    .execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [
      user.id,
      null,
      fileName,
      'xlsx',
      null,
    ])
    .catch((error) => console.error('[api/exports/customers] history log failed:', error));

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
