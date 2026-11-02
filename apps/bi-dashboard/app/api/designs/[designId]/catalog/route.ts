import { NextResponse } from 'next/server';
import { openDesign } from '@/lib/designer/guard';
import { designTools } from '@/lib/designer/engine';
import { toolContext } from '@/lib/tool-setup/chat-planning.mjs';

type Ctx = { params: Promise<{ designId: string }> };

/** Returns only approved field metadata for the report editor; never database rows or credentials. */
export async function GET(_req: Request, { params }: Ctx) {
  const open = await openDesign((await params).designId);
  if (open.error) return open.error;
  if (!open.permissions.canEdit) return NextResponse.json({ error: 'Only the report owner can edit this report.' }, { status: 403 });

  const tools = await designTools(open.design.workspaceId);
  return NextResponse.json({ tools: tools.map((tool) => {
    const context = toolContext(tool, tool.catalog);
    return {
      id: tool.id,
      name: tool.definition.name,
      description: tool.definition.description,
      mode: tool.definition.mode,
      fields: context.fields.map((field: { id: string; type: string; table: string }) => ({ id: field.id, type: field.type, table: field.table })),
    };
  }) });
}
