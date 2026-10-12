import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTING_CONFIG, type UserSettings } from '@/core/types';
import { getAIConfig, hasApiKey } from './get-ai-config';
import { environmentWithoutApiKeys } from '../../subscription-ai-bridge.mjs';

function settings(partial: Partial<UserSettings>): UserSettings {
  return {
    aiProvider: 'codex',
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini',
    codexUrl: '',
    defaultConfig: DEFAULT_LISTING_CONFIG,
    concurrency: 4,
    ...partial,
  };
}

describe('subscription AI (no API key)', () => {
  it('treats Codex as configured without an API key', () => {
    expect(hasApiKey(settings({ aiProvider: 'codex' }))).toBe(true);
    const { aiConfig, apiKey } = getAIConfig(
      settings({ aiProvider: 'codex', codexUrl: 'http://127.0.0.1:18799' })
    );
    expect(aiConfig.provider).toBe('codex');
    expect(aiConfig.apiKey).toBe('');
    expect(aiConfig.codexUrl).toBe('http://127.0.0.1:18799');
    expect(apiKey).toBe('');
  });

  it('strips paid API keys from the Codex child environment', () => {
    const clean = environmentWithoutApiKeys({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      CODEX_API_KEY: 'codex-secret',
      HOME: '/home/jose',
    });
    expect(clean.OPENAI_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.CODEX_API_KEY).toBeUndefined();
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.HOME).toBe('/home/jose');
  });
});
