import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitHeaders,
} from '@/lib/rate-limit/middleware';
import { RATE_LIMITS } from '@/lib/trademark/constants';
import type { AuthContext } from '@/lib/auth/types';

describe('rate limiting', () => {
  it('allows requests within limit', async () => {
    const key = `test-allow-${Date.now()}`;
    const result = await checkRateLimit(key, 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('blocks requests exceeding limit', async () => {
    const key = `test-block-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(key, 10);
    }
    const result = await checkRateLimit(key, 10);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('includes correct headers when allowed', async () => {
    const key = `test-headers-${Date.now()}`;
    const result = await checkRateLimit(key, 30);
    const headers = rateLimitHeaders(result);
    expect(headers['X-RateLimit-Limit']).toBe('30');
    expect(headers['X-RateLimit-Remaining']).toBe('29');
    expect(headers['X-RateLimit-Reset']).toBeDefined();
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('includes Retry-After header when blocked', async () => {
    const key = `test-retry-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(key, 10);
    }
    const result = await checkRateLimit(key, 10);
    const headers = rateLimitHeaders(result);
    expect(headers['Retry-After']).toBeDefined();
  });

  it('uses user ID for a key-scoped rate limit key', () => {
    const auth: AuthContext = {
      tier: 'free',
      source: 'api_key',
      userId: 'user-123',
      rateLimit: 30,
    };
    const key = getRateLimitKey(auth, 'hashed-ip');
    expect(key).toBe('rl:user:user-123');
  });

  it('uses IP for anonymous rate limit key', () => {
    const auth: AuthContext = {
      tier: 'anonymous',
      source: 'anonymous',
      rateLimit: 10,
    };
    const key = getRateLimitKey(auth, 'hashed-ip');
    expect(key).toBe('rl:ip:hashed-ip');
  });

  it('has correct per-tier limits', () => {
    expect(RATE_LIMITS.anonymous).toBe(120);
    expect(RATE_LIMITS.free).toBe(240);
    expect(RATE_LIMITS.premium).toBe(480);
  });

  describe('store outage behavior', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('degrades to in-memory limiting by default when the REST store fails', async () => {
      vi.stubEnv('RATE_LIMIT_REST_URL', 'https://rl.example.com');
      vi.stubEnv('RATE_LIMIT_REST_TOKEN', 'token');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('store down')));
      const result = await checkRateLimit(`test-degrade-${Date.now()}`, 10);
      expect(result.allowed).toBe(true);
    });

    it('fails closed when RATE_LIMIT_FAIL_CLOSED is set', async () => {
      vi.stubEnv('RATE_LIMIT_REST_URL', 'https://rl.example.com');
      vi.stubEnv('RATE_LIMIT_REST_TOKEN', 'token');
      vi.stubEnv('RATE_LIMIT_FAIL_CLOSED', 'true');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('store down')));
      const result = await checkRateLimit(`test-failclosed-${Date.now()}`, 10);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('fails closed on Vercel when the REST store fails', async () => {
      vi.stubEnv('RATE_LIMIT_REST_URL', 'https://rl.example.com');
      vi.stubEnv('RATE_LIMIT_REST_TOKEN', 'token');
      vi.stubEnv('VERCEL', '1');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('store down')));
      const result = await checkRateLimit(`test-vercel-failclosed-${Date.now()}`, 10);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
});
