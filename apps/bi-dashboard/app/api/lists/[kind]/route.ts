// Server-side pagination for row-level list reports (tickets / customers).
// The chat and the saved-report page load only the first page inline; every
// other page is fetched here with the SAME filters the report was built
// from, so the user can browse every row without the browser ever holding
// the whole set. Export Excel (app/api/exports/*) streams all rows.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { warehouseContext } from '@/lib/workspaces/warehouse';
import { workspaceCubePage } from '../../../../../bi-warehouse/src/services/workspaceCube.mjs';
import { modelCatalog } from '../../../../../bi-warehouse/src/semantic/warehouseModel.mjs';
import { warehouseTable } from '../../../../scripts/chat/warehouse-agent.mjs';
import { getTicketList as getTicketListUntyped } from '../../../../../bi-warehouse/src/services/ticketService.mjs';
import { getCustomerList as getCustomerListUntyped } from '../../../../../bi-warehouse/src/services/customerService.mjs';

import { getCustomerFinancials as getCustomerFinancialsUntyped } from '../../../../../bi-warehouse/src/services/revenueService.mjs';
import { querySemanticLayerPage as querySemanticLayerPageUntyped } from '../../../../../bi-warehouse/src/services/cubeQueryService.mjs';
import { buildSemanticQueryTable as buildSemanticQueryTableUntyped } from '../../../../scripts/lib/semantic-table.mjs';

type ListResult = { rows: Record<string, unknown>[]; totalCount: number };
const getCustomerFinancials = getCustomerFinancialsUntyped as unknown as (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
const querySemanticLayerPage = querySemanticLayerPageUntyped as unknown as (
  q: Record<string, unknown>,
  opts: { offset: number; limit: number; maxRows?: number },
) => Promise<{ rows: Record<string, unknown>[]; total: number }>;
const buildSemanticQueryTable = buildSemanticQueryTableUntyped as unknown as (rows: Record<string, unknown>[]) => { headers: string[]; rows: (string | number)[][] };
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
type ListFn = (args: Record<string, unknown>) => Promise<ListResult>;
const getTicketList = getTicketListUntyped as unknown as ListFn;
const getCustomerList = getCustomerListUntyped as unknown as ListFn;

export const runtime = 'nodejs';

const MAX_PAGE_SIZE = 500;

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to view data.' }, { status: 401 });

  const { kind } = await params;
  const sp = new URL(req.url).searchParams;
  const get = (key: string) => sp.get(key) || undefined;
  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(sp.get('pageSize')) || 100)));
  const offset = (page - 1) * pageSize;

  try {
    let result: ListResult;
    if (kind === 'tickets') {
      result = await getTicketList({
        ticketTypeId: get('ticketTypeId'),
        departmentId: get('departmentId'),
        status: get('status'),
        dateFrom: get('dateFrom'),
        dateTo: get('dateTo'),
        limit: pageSize,
        offset,
        withSummary: false,
      });
    } else if (kind === 'customers') {
      result = await getCustomerList({
        dateField: get('dateField'),
        dateFrom: get('dateFrom'),
        dateTo: get('dateTo'),
        popId: get('popId'),
        packageId: get('packageId'),
        statusId: get('statusId'),
        limit: pageSize,
        offset,
        withSummary: false,
      });
    } else if (kind === 'top-customers') {
      // A ranked top-N: page through the first N customers of the ranking.
      const n = Math.max(1, Math.floor(Number(sp.get('limit')) || 100));
      const take = Math.max(0, Math.min(pageSize, n - offset));
      const raw = take
        ? await getCustomerFinancials({ limit: take, offset, sortBy: get('sortBy'), direction: get('direction'), dateFrom: get('dateFrom'), dateTo: get('dateTo') })
        : [];
      const rows = raw.map((row) => ({
        customerId: row.customerId,
        customerName: row.customerName ?? null,
        billed: num(row.billed),
        collected: num(row.collected),
        outstanding: num(row.outstanding),
        refunded: num(row.refunded),
        adjusted: num(row.adjusted),
        packageId: row.packageId ?? null,
        packageName: row.packageName ?? null,
        collectedByTranMode: Object.fromEntries(
          Object.entries((row.collectedByTranMode as Record<string, unknown>) ?? {}).map(([k, v]) => [k, num(v)]),
        ),
      }));
      return NextResponse.json({ rows, page, pageSize });
    } else if (kind === 'semantic') {
      let query: Record<string, unknown>;
      try {
        query = JSON.parse(sp.get('q') || '{}');
      } catch {
        return NextResponse.json({ error: 'Bad query.' }, { status: 400 });
      }
      const maxRows = Number(sp.get('maxRows')) || undefined;
      if (sp.get('workspaceId')) {
        const version = sp.get('modelVersion');
        if (!version) return NextResponse.json({ error: 'Warehouse model version is required.' }, { status: 400 });
        const context = await warehouseContext(sp.get('workspaceId')!, user.id, version);
        const pageResult = await workspaceCubePage(context, query, { offset, limit: pageSize, maxRows });
        return NextResponse.json({ table: warehouseTable(pageResult.rows, query, modelCatalog(context.model)), totalCount: pageResult.total, page, pageSize });
      }
      const result = await querySemanticLayerPage(query, { offset, limit: pageSize, ...(maxRows ? { maxRows } : {}) });
      return NextResponse.json({ table: buildSemanticQueryTable(result.rows), totalCount: result.total, page, pageSize });
    } else {
      return NextResponse.json({ error: 'Unknown list.' }, { status: 404 });
    }
    return NextResponse.json({ rows: result.rows, totalCount: result.totalCount, page, pageSize });
  } catch (error) {
    console.error(`[api/lists/${kind}] page ${page} failed:`, error);
    return NextResponse.json({ error: 'Could not load this page.' }, { status: 500 });
  }
}
