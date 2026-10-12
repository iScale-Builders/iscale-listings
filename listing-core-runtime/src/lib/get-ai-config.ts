import type { UserSettings } from '@/core/types';
import type { AIConfig } from '@/lib/ai-provider';

/**
 * Build an AIConfig from user settings.
 * Returns the config and the active API key.
 */
export function getAIConfig(settings: UserSettings): { aiConfig: AIConfig; apiKey: string } {
  if (settings.aiProvider === 'codex') {
    return {
      aiConfig: { provider: 'codex', apiKey: '', codexUrl: settings.codexUrl },
      apiKey: '',
    };
  }
  return {
    aiConfig: {
      provider: 'openai',
      apiKey: settings.openaiApiKey,
      openaiModel: settings.openaiModel,
    },
    apiKey: settings.openaiApiKey,
  };
}

/**
 * Check if the user has a valid API key configured for their selected provider.
 */
export function hasApiKey(settings: UserSettings): boolean {
  if (settings.aiProvider === 'codex') return true; // local helper needs no key
  return !!settings.openaiApiKey;
}
