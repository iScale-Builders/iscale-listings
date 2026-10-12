import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const checkRateLimit = vi.fn();
const resolveAuth = vi.fn();

vi.mock('@/lib/rate-limit/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit/middleware')>()),
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  resolveAuth: (...a: unknown[]) => resolveAuth(...a),
}));

const allowed = { allowed: true, limit: 600, remaining: 1, resetAt: 0 };
const req = (key?: string) =>
  new NextRequest('http://localhost/api/v1/check', { method: 'POST', headers: key ? { 'x-api-key': key } : {} });
const preauthCalls = () => checkRateLimit.mock.calls.filter(([id]) => String(id).startsWith('preauth:')).length;

describe('root middleware pre-auth throttle (audit 2026-10-07)', () => {
  beforeEach(() => {
    vi.resetModules();
    checkRateLimit.mockReset().mockResolvedValue(allowed);
    resolveAuth.mockReset();
  });

  it('a key that just proved valid skips the shared pre-auth bucket; bad keys never do', async () => {
    const { default: middleware } = await import('@/middleware');
    resolveAuth.mockResolvedValue({ tier: 'premium', source: 'api_key', userId: 'api-key:1', apiKeyId: 1, rateLimit: 5000 });
    await middleware(req('good-key'));
    expect(preauthCalls()).toBe(1);
    await middleware(req('good-key'));
    await middleware(req('good-key'));
    expect(preauthCalls()).toBe(1);
    resolveAuth.mockResolvedValue({ tier: 'anonymous', source: 'anonymous', rateLimit: 120 });
    await middleware(req('bad-key'));
    await middleware(req('bad-key'));
    await middleware(req());
    expect(preauthCalls()).toBe(4);
  });

  it('PRE_AUTH_LIMIT configures the pre-auth bucket', async () => {
    vi.stubEnv('PRE_AUTH_LIMIT', '2000');
    const { default: middleware } = await import('@/middleware');
    resolveAuth.mockResolvedValue({ tier: 'anonymous', source: 'anonymous', rateLimit: 120 });
    await middleware(req());
    expect(checkRateLimit.mock.calls.find(([id]) => String(id).startsWith('preauth:'))?.[1]).toBe(2000);
    vi.unstubAllEnvs();
  });
});
