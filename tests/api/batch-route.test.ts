import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const limitMock = vi.fn();
const orderMock = vi.fn(() => ({ limit: limitMock }));
const eqMock = vi.fn(() => ({ order: orderMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));
const matchTrademarksMock = vi.fn();

class MockCandidateOverflowError extends Error {
  constructor(count: number) {
    super(`Too many candidates generated (${count}). Try checking a shorter section of text.`);
    this.name = 'CandidateOverflowError';
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: fromMock,
  }),
}));

vi.mock('@/lib/trademark/matcher', () => ({
  matchTrademarks: matchTrademarksMock,
  CandidateOverflowError: MockCandidateOverflowError,
}));

function batchRequest(): NextRequest {
  return new NextRequest('https://example.com/api/v1/check/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auth-source': 'api_key',
      'x-auth-tier': 'free',
    },
    body: JSON.stringify({
      items: [
        {
          text: 'vintage cat dad shirt',
          classes: ['025'],
        },
      ],
    }),
  });
}

describe('/api/v1/check/batch route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue({
      data: [{
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 10_873_728,
        created_at: new Date().toISOString(),
      }],
      error: null,
    });
    matchTrademarksMock.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      queryTimeMs: 4,
      truncated: false,
    });
  });

  it('rejects batch requests without an api_key auth source', async () => {
    const { POST } = await import('@/app/api/v1/check/batch/route');
    const request = new NextRequest('https://example.com/api/v1/check/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-tier': 'free',
      },
      body: JSON.stringify({
        items: [{ text: 'vintage cat dad shirt', classes: ['025'] }],
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('caps an unknown stored tier as free', async () => {
    const { POST } = await import('@/app/api/v1/check/batch/route');
    const request = new NextRequest('https://example.com/api/v1/check/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-source': 'api_key',
        'x-auth-tier': 'admin',
      },
      body: JSON.stringify({
        items: Array.from({ length: 6 }, () => ({
          text: 'vintage cat dad shirt',
          classes: ['025'],
        })),
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('BATCH_TOO_LARGE');
  });

  it('returns request-level DB_UNAVAILABLE when item matching hits a database error', async () => {
    const { POST } = await import('@/app/api/v1/check/batch/route');
    matchTrademarksMock.mockRejectedValueOnce({ code: '57014', message: 'statement timeout' });

    const response = await POST(batchRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('DB_UNAVAILABLE');
    expect(body.results).toBeUndefined();
  });

  it('keeps per-item errors for input-specific candidate overflow', async () => {
    const { POST } = await import('@/app/api/v1/check/batch/route');
    matchTrademarksMock.mockRejectedValueOnce(new MockCandidateOverflowError(501));

    const response = await POST(batchRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0]).toEqual(expect.objectContaining({
      matches: [],
      total_matches: 0,
      error: expect.objectContaining({ code: 'CANDIDATE_OVERFLOW' }),
    }));
  });
});
