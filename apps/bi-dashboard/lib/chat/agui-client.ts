import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';

/** One stage of an answer as the chat shows it. */
export type RunStep = { name: string; status: 'active' | 'done'; ms?: number; started?: number };
/** One tool call as the chat shows it: a friendly label, never raw internals. */
export type RunTool = { id: string; name: string; label: string; args?: unknown; status: 'active' | 'done' | 'failed'; rows?: number; ms?: number; note?: string };
export type RunPreview = { title?: string; mode?: string; totalCount?: number; rows: Record<string, unknown>[] };

export type RunView = { text: string; steps: RunStep[]; tools: RunTool[]; preview?: RunPreview };
export const emptyRunView = (): RunView => ({ text: '', steps: [], tools: [] });

export class RunFailed extends Error {
  constructor(message: string, public code: string = 'failed') { super(message); }
}

/** Sends this app's own request body; the AG-UI client handles the event stream. */
class ChatAgent extends HttpAgent {
  constructor(url: string, private payload: unknown) { super({ url }); }
  protected requestInit(): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(this.payload),
      signal: this.abortController.signal,
    };
  }
}

/**
 * Runs one chat answer over AG-UI. `onView` receives the text, stages, tool
 * calls and result preview as they arrive. Resolves with the final result,
 * or throws RunFailed (code 'stopped' when the user pressed Stop).
 */
export async function runChat<T>(
  url: string,
  payload: unknown,
  onView: (view: RunView) => void,
  register: (stop: () => void) => void,
): Promise<T> {
  const agent = new ChatAgent(url, payload);
  let stopped = false;
  register(() => { stopped = true; agent.abortRun(); });
  const view = emptyRunView();
  let result: T | undefined; let failure: RunFailed | undefined; let finished = false;
  const publish = () => onView({ ...view, steps: [...view.steps], tools: [...view.tools] });
  const finishStep = (name?: string) => {
    const step = [...view.steps].reverse().find((s) => s.status === 'active' && (!name || s.name === name));
    if (step) { step.status = 'done'; step.ms = Date.now() - (step.started || Date.now()); }
  };
  try {
    await agent.runAgent({}, {
      onEvent: ({ event }: { event: BaseEvent & Record<string, unknown> }) => {
        switch (event.type) {
          case 'TEXT_MESSAGE_CONTENT': view.text += String(event.delta || ''); break;
          case 'MESSAGES_SNAPSHOT': view.text = String((event.messages as { content?: string }[] | undefined)?.at(-1)?.content || ''); break;
          case 'STEP_STARTED': finishStep(); view.steps.push({ name: String(event.stepName), status: 'active', started: Date.now() }); break;
          case 'STEP_FINISHED': finishStep(String(event.stepName)); break;
          case 'TOOL_CALL_START': view.tools.push({ id: String(event.toolCallId), name: String(event.toolCallName), label: String(event.toolCallName), status: 'active' }); break;
          case 'TOOL_CALL_ARGS': {
            const tool = view.tools.find((t) => t.id === event.toolCallId);
            try { const parsed = JSON.parse(String(event.delta)); if (tool) { tool.label = parsed.label || tool.label; tool.args = parsed.args; } } catch {}
            break;
          }
          case 'TOOL_CALL_RESULT': {
            const tool = view.tools.find((t) => t.id === event.toolCallId);
            try { const r = JSON.parse(String(event.content)); if (tool) Object.assign(tool, { status: r.ok === false ? 'failed' : 'done', rows: r.rows, ms: r.ms, note: r.note }); } catch {}
            break;
          }
          case 'STATE_SNAPSHOT': { const s = event.snapshot as { preview?: RunPreview } | undefined; if (s?.preview) view.preview = s.preview; break; }
          case 'RUN_FINISHED': finishStep(); finished = true; result = event.result as T; break;
          case 'RUN_ERROR': failure = new RunFailed(String(event.message || 'The answer could not be completed.'), String(event.code || 'failed')); break;
          default: return;
        }
        publish();
      },
    });
  } catch (error) {
    if (stopped) throw new RunFailed('Stopped.', 'stopped');
    const payloadError = (error as { payload?: { error?: string } })?.payload?.error;
    throw new RunFailed(payloadError || (error instanceof Error ? error.message : 'The answer could not be completed.'));
  }
  if (stopped) throw new RunFailed('Stopped.', 'stopped');
  if (failure) throw failure;
  if (!finished || result === undefined) throw new RunFailed('The connection ended before the answer was complete. Please try again.');
  return result;
}
