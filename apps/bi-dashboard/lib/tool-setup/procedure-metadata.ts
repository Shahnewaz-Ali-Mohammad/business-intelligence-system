import { getAppDb } from '@/lib/db/app-db';
import { loadProcedureMetadata } from './procedure-catalog.mjs';

// Stored-procedure metadata and approvals, shared by the chat picker and
// scheduled report runs so both apply the same review and approval checks.
export async function readApprovals(sourceId: string): Promise<Record<string, string>> {
  const [rows] = await getAppDb().execute("SELECT JSON_EXTRACT(catalog_json, '$.reportProcedureApprovals') AS approvals FROM bi_tool_sources WHERE id=?", [sourceId]);
  const value = (rows as { approvals?: string | Record<string, string> }[])[0]?.approvals;
  return typeof value === 'string' ? JSON.parse(value) : value || {};
}

export type ParameterMetadata = { name: string; type: string; baseType: string; output: boolean; maxLength: number; precision: number; scale: number; hasDefault?: boolean; tableType?: string; nullable?: boolean; tableColumns?: ParameterMetadata[] };
export type ProcedureMetadata = { id: number; schema: string; name: string; definition: string; hash: string; allowed: boolean; reason: string; requiresWriteConsent: boolean; parameters: ParameterMetadata[] };
export async function procedureMetadata(config: unknown, routineId?: number): Promise<ProcedureMetadata[]> {
  return await loadProcedureMetadata(config, routineId) as ProcedureMetadata[];
}

