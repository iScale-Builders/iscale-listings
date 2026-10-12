import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeysUnavailableError, resolveAuth } from '@/lib/auth/middleware';
import { RATE_LIMITS } from '@/lib/trademark/constants';

const singleMock = vi.fn();
const eqActiveMock = vi.fn(() => ({ single: singleMock }));
const eqHashMock = vi.fn(() => ({ eq: eqActiveMock }));
const selectMock = vi.fn(() => ({ eq: eqHashMock }));
const updateEqMock = vi.fn(() => ({ then: vi.fn() }));
const updateMock = vi.fn(() => ({ eq: updateEqMock }));
const fromMock = vi.fn(() => ({
  select: selectMock,
  update: updateMock,
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: fromMock,
  }),
}));

describe('API auth resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves active API keys from bearer tokens', async () => {
    singleMock.mockResolvedValueOnce({
      data: {
        id: 42,
        user_id: 'user-api',
        key_prefix: 'test-key-prefix',
        tier: 'premium',
        rate_limit: 120,
      },
      error: null,
    });

    const request = new Request('https://example.com/api/v1/check', {
      headers: { Authorization: 'Bearer test-api-key-token' },
    });

    const auth = await resolveAuth(request);

    expect(auth).toEqual({
      tier: 'premium',
      source: 'api_key',
      userId: 'user-api',
      apiKeyId: 42,
      keyPrefix: 'test-key-prefix',
      rateLimit: 120,
    });
    expect(fromMock).toHaveBeenCalledWith('api_keys');
    expect(eqHashMock).toHaveBeenCalledWith(
      'key_hash',
      '19eb2c21b18b28d0838180fd4263716372ae9b66fd3a63613c4aba0bb721dec8'
    );
    expect(eqActiveMock).toHaveBeenCalledWith('is_active', true);
  });

  it('treats an unknown stored api_keys.tier as free', async () => {
    singleMock.mockResolvedValueOnce({
      data: {
        id: 7,
        user_id: 'user-typo',
        key_prefix: 'sp_live_typo',
        tier: 'admin',
        rate_limit: null,
      },
      error: null,
    });

    const request = new Request('https://example.com/api/v1/check', {
      headers: { Authorization: 'Bearer test-api-key-token' },
    });

    const auth = await resolveAuth(request);

    expect(auth.tier).toBe('free');
    expect(auth.source).toBe('api_key');
    expect(auth.rateLimit).toBe(RATE_LIMITS.free);
  });

  it('falls back to anonymous when no credential is present', async () => {
    const request = new Request('https://example.com/api/v1/check');
    const auth = await resolveAuth(request);

    expect(auth).toEqual({
      tier: 'anonymous',
      source: 'anonymous',
      rateLimit: 120,
    });
  });

  it('treats an unknown API key as anonymous', async () => {
    singleMock.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    });

    const request = new Request('https://example.com/api/v1/check', {
      headers: { Authorization: 'Bearer unknown-api-key' },
    });

    await expect(resolveAuth(request)).resolves.toEqual({
      tier: 'anonymous',
      source: 'anonymous',
      rateLimit: 120,
    });
  });

  it('fails closed when api_keys lookup errors for a presented key', async () => {
    singleMock.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'timeout' },
    });

    const request = new Request('https://example.com/api/v1/check', {
      headers: { Authorization: 'Bearer test-api-key-token' },
    });

    await expect(resolveAuth(request)).rejects.toBeInstanceOf(ApiKeysUnavailableError);
  });
});
