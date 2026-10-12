import { describe, it, expect } from 'vitest';
import { blockedWithoutKey, privateModeEnabled } from '@/lib/auth/private-mode';

describe('private mode (REQUIRE_API_KEY)', () => {
  const on = { REQUIRE_API_KEY: 'true' };
  it('is off unless REQUIRE_API_KEY is exactly "true"', () => {
    expect(privateModeEnabled({})).toBe(false);
    expect(privateModeEnabled({ REQUIRE_API_KEY: '1' })).toBe(false);
    expect(privateModeEnabled(on)).toBe(true);
    expect(blockedWithoutKey('/api/v1/check', 'anonymous', {})).toBe(false);
  });
  it('blocks every anonymous /api/v1 call, health included', () => {
    for (const p of ['/api/v1/check', '/api/v1/check/batch', '/api/v1/health']) {
      expect(blockedWithoutKey(p, 'anonymous', on)).toBe(true);
    }
  });
  it('lets a valid API key through', () => {
    expect(blockedWithoutKey('/api/v1/check', 'api_key', on)).toBe(false);
    expect(blockedWithoutKey('/api/v1/health', 'api_key', on)).toBe(false);
  });
  it('leaves the cron route to its own secret check', () => {
    expect(blockedWithoutKey('/api/v1/cron/sync', 'anonymous', on)).toBe(false);
  });
});
