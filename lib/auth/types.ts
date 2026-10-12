export type AuthTier = 'anonymous' | 'free' | 'premium';
export type AuthSource = 'anonymous' | 'api_key';

const AUTH_TIERS: readonly AuthTier[] = ['anonymous', 'free', 'premium'];

export function parseAuthTier(value: unknown, fallback: AuthTier = 'free'): AuthTier {
  return typeof value === 'string' && (AUTH_TIERS as readonly string[]).includes(value)
    ? (value as AuthTier)
    : fallback;
}

export interface AuthContext {
  tier: AuthTier;
  source: AuthSource;
  userId?: string;
  apiKeyId?: number;
  keyPrefix?: string;
  rateLimit: number;
}
