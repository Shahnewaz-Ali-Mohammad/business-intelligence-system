import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { openDesign } from '@/lib/designer/guard';
import { designTurn, runSpec, writeInsights } from '@/lib/designer/engine';
import { saveDesign } from '@/lib/designer/store';
import { todayIn } from '@/lib/tool-setup/procedure-fill.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';
import type { Message } from '@/lib/designer/spec';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({ text: z.string().trim().min(1).max(2000), selectedBlockId: z.string().max(40).nullable().optional(), timezone: z.string().max(64).optional() }).strict();

/** One designer turn: the request becomes validated block changes, run on live data. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ designId: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const open = await openDesign((await params).designId); if (open.error) return open.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { design, guard } = open;
  const { text, selectedBlockId = null, timezone } = parsed.data;
  const now = new Date().toISOString();
  try {
    const today = todayIn(timezone || 'UTC');
    const turn = await designTurn({ workspaceId: design.workspaceId, spec: design.spec, messages: design.messages, text, selectedBlockId, today: `${today.date} (${today.weekday})` });
    const data = await runSpec(design.workspaceId, turn.spec, guard.access);
    const changed = new Set(turn.ops.map((o) => o.blockId));
    const spec = await writeInsights(turn.spec, data, changed);
    const messages: Message[] = [...design.messages, { role: 'user', text, at: now, blockId: selectedBlockId }, { role: 'assistant', text: turn.reply, at: new Date().toISOString() }];
    await saveDesign(design.id, guard.user.id, spec, messages, text);
    return NextResponse.json({ spec, data, reply: turn.reply, suggestions: turn.suggestions, changed: [...changed], messages });
  } catch (error) {
    console.error('[designer] turn failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'The designer could not finish that change. Try again or rephrase it.' }, { status: 502 });
  }
}
