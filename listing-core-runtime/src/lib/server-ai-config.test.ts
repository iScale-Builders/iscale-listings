import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveServerAIConfig } from './server-ai-config';

describe('resolveServerAIConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not use server provider keys unless explicitly enabled', () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-key');

    const result = resolveServerAIConfig({ aiConfig: { provider: 'openai' } });

    expect(result).toEqual({
      error:
        'No API key configured for openai. Provide a key in Settings or enable server keys with ISCALE_LISTINGS_ALLOW_SERVER_AI_KEYS=true and set OPENAI_API_KEY.',
    });
  });

  it('uses server provider keys when the app explicitly enables them', () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-key');
    vi.stubEnv('ISCALE_LISTINGS_ALLOW_SERVER_AI_KEYS', 'true');

    const result = resolveServerAIConfig({ aiConfig: { provider: 'openai' } });

    expect(result).toMatchObject({
      apiKey: 'server-key',
      aiConfig: {
        provider: 'openai',
        apiKey: 'server-key',
      },
    });
  });

  it('prefers an explicit request key over the server key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-key');
    vi.stubEnv('ISCALE_LISTINGS_ALLOW_SERVER_AI_KEYS', 'true');

    const result = resolveServerAIConfig({
      apiKey: 'request-key',
      aiConfig: { provider: 'openai' },
    });

    expect(result).toMatchObject({
      apiKey: 'request-key',
      aiConfig: {
        provider: 'openai',
        apiKey: 'request-key',
      },
    });
  });
});
