// Whole-customer-LIST .xlsx export -- same fix as app/api/exports/tickets
// (see that file's own comment for the full reasoning: Excel-only by this
// app's own existing rule, re-queries fresh via a real cursor, accumulates
// into one workbook since xlsx has no true streaming writer). Deliberately
// separate from app/api/exports/customers, which exports the
// top_customers/customer_summary FINANCIALS breakdown, not this topic's
// row shape (POP/package/status/entry date).
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { streamAllCustomerList as streamAllCustomerListUntyped } from '../../../../../bi-warehouse/src/services/customerService.mjs';

type CustomerListRow = {
  customer_id: string | number;
  customer_name: string | null;
  pop_id: string | number | null;
  pop_name: string | null;
  package_id: string | number | null;
  package_name: string | null;
  status_id: string | number | null;
  status_name: string | null;
  entry_date: string | null;
  activated_date: string | null;
};

const streamAllCustomerList = streamAllCustomerListUntyped as (
  args: { dateField?: 'entry' | 'activated'; dateFrom?: string; dateTo?: string; popId?: string; packageId?: string; statusId?: string },
  onBatch: (rows: CustomerListRow[]) => Promise<void> | void,
) => Promise<{ totalRows: number }>;

export const runtime = 'nodejs';
export const maxDuration = 300;

const HEADERS = [
  'Customer ID',
  'Customer Name',
  'POP ID',
  'POP Name',
  'Package ID',
  'Package Name',
  'Status ID',
  'Status Name',
  'Entry Date',
  'Activated Date',
];

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response('Sign in to export data.', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const dateField = (searchParams.get('dateField') as 'entry' | 'activated' | null) || undefined;
  const dateFrom = searchParams.get('dateFrom') || undefined;
  const dateTo = searchParams.get('dateTo') || undefined;
  const popId = searchParams.get('popId') || undefined;
  const packageId = searchParams.get('packageId') || undefined;
  const statusId = searchParams.get('statusId') || undefined;

  const aoa: (string | number | null)[][] = [HEADERS];
  try {
    await streamAllCustomerList({ dateField, dateFrom, dateTo, popId, packageId, statusId }, (batch) => {
      for (const row of batch) {
        aoa.push([
          row.customer_id,
          row.customer_name,
          row.pop_id,
          row.pop_name,
          row.package_id,
          row.package_name,
          row.status_id,
          row.status_name,
          row.entry_date,
          row.activated_date,
        ]);
      }
    });
  } catch (error) {
    console.error('[api/exports/customer-list] query failed:', error);
    return NextResponse.json({ error: 'Could not build the full customer export.' }, { status: 500 });
  }

  const totalRows = aoa.length - 1;
  console.log(`[api/exports/customer-list] built xlsx with ${totalRows} customer rows`);

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'All Customers');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const fileName = `all-customers-${new Date().toISOString().slice(0, 10)}.xlsx`;
  getAppDb()
    .execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [
      user.id,
      null,
      fileName,
      'xlsx',
      null,
    ])
    .catch((error) => console.error('[api/exports/customer-list] history log failed:', error));

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
