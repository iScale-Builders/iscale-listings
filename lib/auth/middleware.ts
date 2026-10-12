import { RATE_LIMITS } from '@/lib/trademark/constants';
import { createServiceClient } from '@/lib/supabase/server';
import { sha256Hex } from './api-keys';
import { parseAuthTier, type AuthContext, type AuthTier } from './types';

export class ApiKeysUnavailableError extends Error {
  constructor() {
    super('API_KEYS_UNAVAILABLE');
    this.name = 'ApiKeysUnavailableError';
  }
}

interface ApiKeyRow {
  id: number;
  user_id: string | null;
  key_prefix: string | null;
  tier: AuthTier;
  rate_limit: number | null;
}

export function getApiKeyCredential(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }

  return request.headers.get('x-api-key')?.trim() || null;
}

async function resolveApiKeyAuth(request: Request): Promise<AuthContext | null> {
  const credential = getApiKeyCredential(request);
  if (!credential) return null;

  const keyHash = await sha256Hex(credential);
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('api_keys')
    .select('id,user_id,key_prefix,tier,rate_limit')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .single();

  if (error) {
    // PGRST116 = 0 rows from .single() — unknown key, not a DB outage.
    if (error.code === 'PGRST116') return null;
    console.error('api_keys lookup failed (failing closed):', error);
    throw new ApiKeysUnavailableError();
  }
  if (!data) return null;

  const row = data as ApiKeyRow;
  const tier = parseAuthTier(row.tier, 'free');

  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(undefined, (err) => console.error('Failed to update api_key last_used_at:', err));

  return {
    tier,
    source: 'api_key',
    userId: row.user_id ?? `api-key:${row.id}`,
    apiKeyId: row.id,
    keyPrefix: row.key_prefix ?? undefined,
    rateLimit: row.rate_limit ?? RATE_LIMITS[tier],
  };
}

/**
 * Auth resolution order:
 * 1. API key credential -> stored key tier
 * 2. No credentials -> Anonymous tier
 */
export async function resolveAuth(request: Request): Promise<AuthContext> {
  const apiKeyAuth = await resolveApiKeyAuth(request);
  if (apiKeyAuth) return apiKeyAuth;

  // Anonymous
  return {
    tier: 'anonymous',
    source: 'anonymous',
    rateLimit: RATE_LIMITS.anonymous,
  };
}

