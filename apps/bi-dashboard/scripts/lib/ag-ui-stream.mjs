// AG-UI events carry user-facing text only, never planner/tool internals.
export function createRunEvents(emit, { threadId, runId, messageId }) {
  let text = '', ended = false;
  emit({ type: 'RUN_STARTED', threadId, runId });
  emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  return {
    progress(name) { if (!ended) emit({ type: 'CUSTOM', name: 'bi_progress', value: name }); },
    text(next) {
      if (ended || next === text) return;
      if (next.startsWith(text)) emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: next.slice(text.length) });
      else emit({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: messageId, role: 'assistant', content: next }] });
      text = next;
    },
    finish(result) {
      if (ended) return;
      this.text(result.narrative);
      emit({ type: 'TEXT_MESSAGE_END', messageId });
      emit({ type: 'CUSTOM', name: 'bi_result', value: result });
      emit({ type: 'RUN_FINISHED', threadId, runId });
      ended = true;
    },
    error(message) {
      if (ended) return;
      emit({ type: 'RUN_ERROR', message });
      ended = true;
    },
  };
}

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

export const eventFrame = (event) => `data: ${JSON.stringify(event)}\n\n`;
