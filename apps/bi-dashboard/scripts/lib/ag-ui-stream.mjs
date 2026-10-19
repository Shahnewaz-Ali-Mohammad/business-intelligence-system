import crypto from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';

const encoder = new EventEncoder();
/** One AG-UI event as a Server-Sent Events frame. */
export const eventFrame = (event) => encoder.encodeSSE(event);
export const AG_UI_CONTENT_TYPE = encoder.getContentType();

/**
 * One chat answer as an AG-UI run. Events carry user-facing text, stage
 * names, tool labels and result previews only, never planner internals.
 * Every open step, tool call and text message is closed before the run
 * ends, as the protocol requires.
 */
export function createRunEvents(emit, { threadId, runId, messageId }) {
  let text = '', ended = false, textOpen = false, step = null;
  const steps = [];
  const tools = new Map();
  const send = (event) => { if (!ended) emit(event); };
  emit({ type: EventType.RUN_STARTED, threadId, runId });

  const openText = () => {
    if (textOpen) return;
    textOpen = true;
    send({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  };
  const endStep = () => {
    if (!step) return;
    step.ms = Date.now() - step.started;
    send({ type: EventType.STEP_FINISHED, stepName: step.name });
    step = null;
  };
  const closeAll = () => {
    for (const id of tools.keys()) api.toolEnd(id, { ok: false, note: 'Stopped' });
    endStep();
    if (textOpen) { send({ type: EventType.TEXT_MESSAGE_END, messageId }); textOpen = false; }
  };

  const api = {
    /** Starts a named stage; the previous stage is marked finished. */
    step(name) {
      if (ended || !name || step?.name === name) return;
      endStep();
      step = { name: String(name), started: Date.now(), ms: 0 };
      steps.push(step);
      send({ type: EventType.STEP_STARTED, stepName: step.name });
    },
    progress(name) { api.step(name); },
    /** Sends the answer text so far: appended text as a delta, a rewrite as a snapshot. */
    text(next) {
      next = String(next ?? '');
      if (ended || next === text) return;
      openText();
      if (next.startsWith(text)) send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: next.slice(text.length) });
      else send({ type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: messageId, role: 'assistant', content: next }] });
      text = next;
    },
    /** A tool call the user may see: a friendly label plus its arguments. */
    toolStart({ name, label, args }) {
      const id = crypto.randomUUID();
      if (ended) return id;
      tools.set(id, { started: Date.now(), label });
      send({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: String(name || 'tool') });
      send({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify({ label: label || name, args: args ?? {} }) });
      return id;
    },
    /** @param {string} id @param {{ ok?: boolean, rows?: number, note?: string }} [outcome] */
    toolEnd(id, { ok = true, rows = undefined, note = undefined } = {}) {
      const call = tools.get(id);
      if (!call || ended) return;
      tools.delete(id);
      send({ type: EventType.TOOL_CALL_END, toolCallId: id });
      send({ type: EventType.TOOL_CALL_RESULT, messageId: crypto.randomUUID(), toolCallId: id, role: 'tool', content: JSON.stringify({ label: call.label, ok, rows, note, ms: Date.now() - call.started }) });
    },
    /** Shared state, e.g. the result table before the insight is written. */
    state(snapshot) { send({ type: EventType.STATE_SNAPSHOT, snapshot }); },
    /** Stages so far with their durations (the running one counts until now). */
    steps() { return steps.map((s) => ({ name: s.name, ms: s === step ? Date.now() - s.started : s.ms })); },
    finish(result) {
      if (ended) return;
      if (result?.narrative) api.text(result.narrative);
      closeAll();
      send({ type: EventType.RUN_FINISHED, threadId, runId, result });
      ended = true;
    },
    error(message, code = 'failed') {
      if (ended) return;
      closeAll();
      send({ type: EventType.RUN_ERROR, message, code });
      ended = true;
    },
  };
  return api;
}

/** Reads an AG-UI SSE response on the server (used when one route relays another). */
export async function readEventStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = () => {
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') onEvent(JSON.parse(data));
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      consume();
    }
    buffer += decoder.decode();
    if (buffer.trim()) { buffer += '\n\n'; consume(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Short machine-readable reason for a failed answer, so the client can offer the right next step. */
export function errorCode(error, signal) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (signal?.aborted || /timeout|timed out|took too long/i.test(message)) return 'timeout';
  if (/Approval changed/i.test(message)) return 'approval_changed';
  if (/Schema changed/i.test(message)) return 'schema_changed';
  if (/Query exceeds|too large|row limit/i.test(message)) return 'too_large';
  return 'failed';
}
