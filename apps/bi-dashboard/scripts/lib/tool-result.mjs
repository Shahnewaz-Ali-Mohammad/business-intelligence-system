export function parseToolResult(result) {
  const value = typeof result === 'string' ? JSON.parse(result) : result;
  if (value?.structuredContent) return value.structuredContent;
  const blocks = Array.isArray(value) && value.some((b) => b?.type === 'text') ? value : value?.content;
  if (blocks) {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return JSON.parse(text);
  }
  return value;
}
