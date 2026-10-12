import type { AIConfig, AIProvider } from '@/lib/ai-provider';

interface ResolveAIConfigInput {
  apiKey?: string;
  aiConfig?: Partial<AIConfig>;
}

interface ResolveAIConfigSuccess {
  aiConfig: AIConfig;
  apiKey: string;
}

interface ResolveAIConfigFailure {
  error: string;
}

export type ResolveAIConfigResult = ResolveAIConfigSuccess | ResolveAIConfigFailure;

function isProvider(value: unknown): value is AIProvider {
  return value === 'openai';
}

function getEnvKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

function serverKeysEnabled(): boolean {
  return process.env.ISCALE_LISTINGS_ALLOW_SERVER_AI_KEYS === 'true';
}

/**
 * Resolve provider + key for server AI calls.
 * Priority: request key -> provider env key.
 */
export function resolveServerAIConfig(input: ResolveAIConfigInput): ResolveAIConfigResult {
  const provider = isProvider(input.aiConfig?.provider) ? input.aiConfig.provider : 'openai';

  const explicitKey = (input.aiConfig?.apiKey ?? input.apiKey ?? '').trim();
  const envKey = serverKeysEnabled() ? (getEnvKey() ?? '').trim() : '';
  const resolvedKey = explicitKey || envKey;

  if (!resolvedKey) {
    return {
      error: `No API key configured for ${provider}. Provide a key in Settings or enable server keys with ISCALE_LISTINGS_ALLOW_SERVER_AI_KEYS=true and set OPENAI_API_KEY.`,
    };
  }

  return {
    apiKey: resolvedKey,
    aiConfig: {
      ...(input.aiConfig ?? {}),
      provider,
      apiKey: resolvedKey,
    },
  };
}
