import { Agent } from 'undici';
// Generation calls can run for several minutes; Node's default fetch gives up
// waiting for response headers after 5 minutes, before the SDK timeout.
const longRequests = new Agent({ headersTimeout: 660000, bodyTimeout: 660000 });
export function generationSettings(env = process.env) {
  const model = env.TOOL_GENERATION_MODEL || 'gpt-6-astra';
  const reasoning = /^(gpt-[56]|o[134])/.test(model);
  const effort = env.TOOL_GENERATION_REASONING_EFFORT || 'high';
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('Tool generation reasoning effort must be low, medium or high.');
  return { model, timeout: 600000, maxRetries: 0, configuration: { fetchOptions: { dispatcher: longRequests } },
    modelKwargs: { max_completion_tokens: 16000, ...(reasoning ? { reasoning_effort: effort } : {}) } };
}
