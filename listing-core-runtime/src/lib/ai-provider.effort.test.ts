import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion, visionCompletion } from './ai-provider';
afterEach(() => vi.unstubAllGlobals());
describe('request-local helper effort', () => {
  it('forwards config budget, lets request options override, and omits default', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ text: 'ok' }), { status: 200 }); }));
    const config = { provider: 'codex' as const, apiKey: '', localModel: 'gpt-6-sol', localReasoningEffort: 'low' as const };
    await chatCompletion(config, 'draft');
    await visionCompletion(config, 'image', 'analysis', { localReasoningEffort: 'high' });
    await chatCompletion({ provider: 'codex', apiKey: '' }, 'other');
    expect(bodies[0]).toMatchObject({ reasoningEffort: 'low', model: 'gpt-6-sol' });
    expect(bodies[1]).toMatchObject({ reasoningEffort: 'high' });
    expect(bodies[2]).not.toHaveProperty('reasoningEffort');
  });
  it('does not send the Codex budget to the API-key provider', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); }));
    await chatCompletion({ provider: 'openai', apiKey: 'test', localReasoningEffort: 'low' }, 'x');
    expect(body).not.toHaveProperty('reasoningEffort');
    expect(body).not.toHaveProperty('localReasoningEffort');
  });
});
