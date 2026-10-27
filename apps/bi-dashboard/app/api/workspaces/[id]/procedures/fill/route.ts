import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { requireAccess, denied, canOpenWorkspace } from '@/lib/access/guard';
import { enterAccess } from '@/lib/access/data-scope.mjs';
import { getWorkspace } from '@/lib/workspaces/workspaceDb';
import { getSource } from '@/lib/tool-setup/store';
import { procedureMetadata } from '@/lib/tool-setup/procedure-metadata';
import { proposalToForm, pickPrompt, fillPrompt, todayIn } from '@/lib/tool-setup/procedure-fill.mjs';
import { isSameOriginRequest } from '@/lib/tool-setup/request-origin.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  sourceId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(2000),
  timezone: z.string().max(64).optional(),
  procedureId: z.number().int().positive().optional(),
}).strict();

const model = () => new ChatOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-4o', temperature: 0, timeout: 20000, maxRetries: 1 });

/**
 * Reads a chat message and proposes which available report procedure to run
 * and the values for its form. Nothing runs here: the form opens filled in
 * and the person presses Generate Report.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'Invalid origin.' }, { status: 403 });
  const guard = await requireAccess('procedures.run'); if (denied(guard)) return guard; enterAccess(guard.access);
  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace || !(await canOpenWorkspace(guard.access, id))) return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { sourceId, text, timezone, procedureId } = parsed.data;
  try {
    const source = await getSource(id, sourceId);
    if (source.config.dialect !== 'sqlserver') return NextResponse.json({ error: 'Report procedures are supported for SQL Server databases only.' }, { status: 400 });
    let chosenId = procedureId;
    if (!chosenId) {
      const available = (await procedureMetadata(source.config)).filter((p) => p.allowed);
      if (!available.length) return NextResponse.json({ error: 'No report procedures are available for this database.' }, { status: 404 });
      const pick = await model().withStructuredOutput(z.object({ procedureId: z.number().int().nullable() })).invoke(pickPrompt(text, available.slice(0, 300)));
      chosenId = available.some((p) => p.id === pick.procedureId) ? Number(pick.procedureId) : undefined;
      if (!chosenId) return NextResponse.json({ matched: false, message: 'No report matches that. Pick one from the list.' });
    }
    const [procedure] = await procedureMetadata(source.config, chosenId);
    if (!procedure?.allowed) return NextResponse.json({ matched: false, message: procedure?.reason || 'That report is unavailable.' });
    const proposal = await model()
      .withStructuredOutput(z.object({ values: z.array(z.object({ name: z.string(), value: z.string().nullable() })) }))
      .invoke(fillPrompt(text, procedure, todayIn(timezone || 'UTC')));
    const form = proposalToForm(procedure.parameters, proposal);
    return NextResponse.json({ matched: true, procedureId: procedure.id, name: `${procedure.schema}.${procedure.name}`, ...form });
  } catch (error) {
    console.error('[procedure fill] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not fill the report form. Fill it in by hand.' }, { status: 502 });
  }
}
