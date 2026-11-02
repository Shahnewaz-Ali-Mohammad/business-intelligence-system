import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { openDesign } from '@/lib/designer/guard';
import { designTurn, runSpec, writeInsights } from '@/lib/designer/engine';
import { saveDesign } from '@/lib/designer/store';
import { todayIn } from '@/lib/tool-setup/procedure-fill.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import { isDataBlock, type Message } from '@/lib/designer/spec';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({ text: z.string().trim().min(1).max(2000), selectedBlockId: z.string().max(40).nullable().optional(), timezone: z.string().max(64).optional() }).strict();

/** One designer turn: the request becomes validated block changes, run on live data. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ designId: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  if (!open.permissions.canEdit) return NextResponse.json({ error: 'Only the report owner can make design changes.' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { design, guard } = open;
  const { text, selectedBlockId = null, timezone } = parsed.data;
  const now = new Date().toISOString();
  try {
    const today = todayIn(timezone || 'UTC');
    const turn = await designTurn({ workspaceId: design.workspaceId, spec: design.spec, messages: design.messages, text, selectedBlockId, today: `${today.date} (${today.weekday})` });
    const changed = new Set(turn.ops.map((o) => o.blockId));
    const newDataIds = new Set(turn.spec.blocks.filter((block) => isDataBlock(block) && !design.spec.blocks.some((previous) => previous.id === block.id)).map((block) => block.id));
    const neededIds = new Set([...changed, ...newDataIds]);
    for (const block of turn.spec.blocks) {
      if (block.type === 'insight' && block.sourceBlockId && (changed.has(block.id) || !block.text)) neededIds.add(block.sourceBlockId);
    }
    const neededSpec = { ...turn.spec, blocks: turn.spec.blocks.filter((block) => isDataBlock(block) && neededIds.has(block.id)) };
    const data = neededSpec.blocks.length ? await runSpec(design.workspaceId, neededSpec, guard.access) : {};
    const spec = await writeInsights(turn.spec, data, changed);
    const messages: Message[] = [...design.messages, { role: 'user', text, at: now, blockId: selectedBlockId }, { role: 'assistant', text: turn.reply, at: new Date().toISOString() }];
    await saveDesign(design.id, guard.user.id, spec, messages, text);
    return NextResponse.json({ spec, data, reply: turn.reply, suggestions: turn.suggestions, changed: [...changed], messages });
  } catch (error) {
    console.error('[designer] turn failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'The designer could not finish that change. Try again or rephrase it.' }, { status: 502 });
  }
}
