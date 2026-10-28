import { z } from 'zod';

// A designed report is a list of blocks. Data blocks carry the approved tool
// and a structured query plan; the rows are never stored, they are fetched
// fresh every time the report opens.

export const BLOCK_TYPES = ['heading', 'kpi', 'chart', 'table', 'text', 'insight'] as const;
export const CHART_KINDS = ['bar', 'hbar', 'line', 'area', 'pie', 'stacked'] as const;
export const WIDTHS = ['full', 'half', 'third'] as const;

export const BlockSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(BLOCK_TYPES),
  title: z.string().max(200),
  width: z.enum(WIDTHS),
  toolId: z.string().max(64).nullable(),
  query: z.string().max(20000).nullable(),
  chartKind: z.enum(CHART_KINDS).nullable(),
  format: z.enum(['number', 'currency', 'percent']).nullable(),
  text: z.string().max(4000).nullable(),
  sourceBlockId: z.string().max(40).nullable(),
});
export type Block = z.infer<typeof BlockSchema>;

export const SpecSchema = z.object({
  title: z.string().max(200),
  subtitle: z.string().max(400),
  blocks: z.array(BlockSchema).max(40),
});
export type Spec = z.infer<typeof SpecSchema>;

export const OpSchema = z.object({
  op: z.enum(['add', 'update', 'remove', 'move']),
  blockId: z.string().min(1).max(40),
  index: z.number().int().min(0).max(40).nullable(),
  block: BlockSchema.nullable(),
});
export type Op = z.infer<typeof OpSchema>;

export type Message = { role: 'user' | 'assistant'; text: string; at: string; blockId?: string | null };

export const emptySpec = (): Spec => ({ title: 'Untitled report', subtitle: '', blocks: [] });

export const isDataBlock = (b: Block) => b.type === 'kpi' || b.type === 'chart' || b.type === 'table';

/** Applies the designer's change list to a spec, ignoring changes that do not fit. */
export function applyOps(spec: Spec, ops: Op[]): Spec {
  const blocks = [...spec.blocks];
  for (const op of ops) {
    const at = blocks.findIndex((b) => b.id === op.blockId);
    if (op.op === 'remove') { if (at >= 0) blocks.splice(at, 1); continue; }
    if (op.op === 'move') {
      if (at < 0 || op.index == null) continue;
      const [b] = blocks.splice(at, 1); blocks.splice(Math.min(op.index, blocks.length), 0, b); continue;
    }
    if (!op.block) continue;
    const block = { ...op.block, id: op.blockId };
    if (op.op === 'update' && at >= 0) blocks[at] = { ...blocks[at], ...block };
    else if (at < 0 && blocks.length < 40) blocks.splice(op.index == null ? blocks.length : Math.min(op.index, blocks.length), 0, block);
  }
  return { ...spec, blocks };
}
