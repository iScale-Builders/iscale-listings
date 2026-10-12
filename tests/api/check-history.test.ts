import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const insertMock = vi.fn();
const limitMock = vi.fn();
const orderMock = vi.fn(() => ({ limit: limitMock }));
const eqMock = vi.fn(() => ({ order: orderMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn((table: string) => {
  if (table === 'check_history') {
    return { insert: insertMock };
  }
  return { select: selectMock };
});
const matchTrademarksMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: fromMock,
  }),
}));

vi.mock('@/lib/trademark/matcher', () => ({
  matchTrademarks: matchTrademarksMock,
  CandidateOverflowError: class extends Error {},
}));

function checkRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/v1/check', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      text: 'vintage cat dad shirt',
      classes: ['025'],
    }),
  });
}

describe('/api/v1/check history writes', () => {
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
    insertMock.mockReturnValue({
      then: (_ok?: unknown, err?: (reason: unknown) => void) => {
        void err;
        return Promise.resolve({ error: null });
      },
    });
    matchTrademarksMock.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      queryTimeMs: 4,
      truncated: false,
    });
  });

  it('does not write check_history for anonymous requests', async () => {
    const { POST } = await import('@/app/api/v1/check/route');
    const response = await POST(checkRequest());
    expect(response.status).toBe(200);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('writes truncated input_text for API-key requests', async () => {
    const { POST } = await import('@/app/api/v1/check/route');
    const response = await POST(
      checkRequest({
        'x-auth-source': 'api_key',
        'x-auth-api-key-id': '1',
      })
    );
    expect(response.status).toBe(200);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key_id: 1,
        input_text: 'vintage cat dad shirt',
      })
    );
  });
});
