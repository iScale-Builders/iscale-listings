import { describe, expect, it } from 'vitest';
import { trustedClientAddressFromHeaders } from '@/lib/http/client-address';

describe('trusted client address parsing', () => {
  it('prefers X-Real-IP (proxy-set, unspoofable) over X-Forwarded-For', () => {
    const headers = new Headers({
      'x-real-ip': '198.51.100.22',
      'x-forwarded-for': 'forged-spoof, 203.0.113.11',
    });

    expect(trustedClientAddressFromHeaders(headers)).toBe('198.51.100.22');
  });

  it('falls back to the RIGHTMOST X-Forwarded-For hop, not the spoofable leftmost', () => {
    // Regression: taking the leftmost let a caller prefix a forged entry and
    // rotate it per request to bypass per-IP rate limiting. The trusted proxy
    // appends the real observed address on the right.
    const headers = new Headers({
      'x-forwarded-for': 'forged-client, 203.0.113.11, 203.0.113.12',
    });

    expect(trustedClientAddressFromHeaders(headers)).toBe('203.0.113.12');
  });

  it('returns an explicit unknown marker without trusted address headers', () => {
    expect(trustedClientAddressFromHeaders(new Headers())).toBe('unknown-client');
  });
});
