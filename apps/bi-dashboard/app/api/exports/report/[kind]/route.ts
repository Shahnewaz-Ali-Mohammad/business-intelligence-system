// Full-dataset .xlsx export for ranked-customer and semantic-layer reports
// (ticket/customer lists have their own routes). Re-runs the report's own
// stored query page by page (5,000 rows per database call, so no single
// request is unbounded) until every row is in the workbook.
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { projectColumns, exportHiddenColumns } from '@/lib/dashboard/column-visibility.mjs';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppDb } from '@/lib/db/app-db';
import { getReportTable } from '@/lib/dashboard/report-table';
import type { DashboardData } from '@/lib/dashboard/metrics';
import { getCustomerFinancials as getCustomerFinancialsUntyped } from '../../../../../../bi-warehouse/src/services/revenueService.mjs';
import { querySemanticLayerPage as querySemanticLayerPageUntyped } from '../../../../../../bi-warehouse/src/services/cubeQueryService.mjs';
import { buildSemanticQueryTable as buildSemanticQueryTableUntyped } from '../../../../../scripts/lib/semantic-table.mjs';

const getCustomerFinancials = getCustomerFinancialsUntyped as unknown as (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
const querySemanticLayerPage = querySemanticLayerPageUntyped as unknown as (
  q: Record<string, unknown>,
  opts: { offset: number; limit: number; maxRows?: number },
) => Promise<{ rows: Record<string, unknown>[]; total: number }>;
const buildSemanticQueryTable = buildSemanticQueryTableUntyped as unknown as (rows: Record<string, unknown>[]) => { headers: string[]; rows: (string | number)[][] };

export const runtime = 'nodejs';
export const maxDuration = 300;

const BATCH = 5000;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response('Sign in to export data.', { status: 401 });
  const { kind } = await params;
  const sp = new URL(req.url).searchParams;

  let headers: string[] = [];
  const rows: (string | number)[][] = [];
  try {
    if (kind === 'top-customers') {
      const n = Math.max(1, Math.floor(Number(sp.get('limit')) || 100));
      for (let offset = 0; offset < n; offset += BATCH) {
        const raw = await getCustomerFinancials({
          limit: Math.min(BATCH, n - offset),
          offset,
          sortBy: sp.get('sortBy') || undefined,
          direction: sp.get('direction') || undefined,
          dateFrom: sp.get('dateFrom') || undefined,
          dateTo: sp.get('dateTo') || undefined,
        });
        const batch = raw.map((row) => ({
          ...row,
          billed: num(row.billed),
          collected: num(row.collected),
          outstanding: num(row.outstanding),
          refunded: num(row.refunded),
          adjusted: num(row.adjusted),
          collectedByTranMode: Object.fromEntries(
            Object.entries((row.collectedByTranMode as Record<string, unknown>) ?? {}).map(([k, v]) => [k, num(v)]),
          ),
        }));
        const t = getReportTable('top_customers', { customerFinancials: batch } as unknown as DashboardData);
        if (!headers.length) headers = t.headers;
        rows.push(...t.rows);
        if (raw.length < Math.min(BATCH, n - offset)) break;
      }
    } else if (kind === 'semantic') {
      const query = JSON.parse(sp.get('q') || '{}') as Record<string, unknown>;
      const maxRows = Number(sp.get('maxRows')) || undefined;
      for (let offset = 0; ; offset += BATCH) {
        const page = await querySemanticLayerPage(query, { offset, limit: BATCH, ...(maxRows ? { maxRows } : {}) });
        const t = buildSemanticQueryTable(page.rows);
        if (!headers.length && page.rows.length) headers = t.headers;
        rows.push(...t.rows);
        if (page.rows.length < BATCH || offset + BATCH >= page.total) break;
      }
    } else {
      return NextResponse.json({ error: 'Unknown export.' }, { status: 404 });
    }
  } catch (error) {
    console.error(`[api/exports/report/${kind}] failed:`, error);
    return NextResponse.json({ error: 'Could not build the export.' }, { status: 500 });
  }

  const projected = projectColumns(headers, rows, exportHiddenColumns(sp));
  const worksheet = XLSX.utils.aoa_to_sheet([projected.headers, ...projected.rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const fileName = `${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  getAppDb()
    .execute('INSERT INTO report_exports (user_id, report_id, file_name, format, file_content) VALUES (?, ?, ?, ?, ?)', [user.id, null, fileName, 'xlsx', null])
    .catch((error) => console.error(`[api/exports/report/${kind}] history log failed:`, error));
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
