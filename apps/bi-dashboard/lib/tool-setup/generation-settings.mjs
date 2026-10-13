export function generationSettings(env = process.env) {
  const model = env.TOOL_GENERATION_MODEL || 'gpt-6-astra';
  const reasoning = /^(gpt-[56]|o[134])/.test(model);
  const effort = env.TOOL_GENERATION_REASONING_EFFORT || 'high';
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('Tool generation reasoning effort must be low, medium or high.');
  return { model, timeout: 240000, maxRetries: 1,
    modelKwargs: { max_completion_tokens: 16000, ...(reasoning ? { reasoning_effort: effort } : {}) } };
}
