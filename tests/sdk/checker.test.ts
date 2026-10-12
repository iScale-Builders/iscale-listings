import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We import directly from the source files so the tests run without
// building the SDK first.
import { TrademarkChecker, TrademarkCheckerError } from '../../sdk/src/index';
import type { CheckResponse, BatchResponse, HealthResponse } from '../../sdk/src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createChecker(baseUrl = 'https://test.example.com'): TrademarkChecker {
  return new TrademarkChecker({ apiKey: 'test-api-key-token', baseUrl });
}

/**
 * Start a check call and immediately attach a catch handler so the rejection
 * is never "unhandled". Returns a promise that resolves with either the
 * successful result or the caught error.
 */
function safeCheck(
  checker: TrademarkChecker,
  request: { text: string; classes: string[] }
): Promise<CheckResponse | TrademarkCheckerError> {
  return checker.check(request).catch((err: TrademarkCheckerError) => err);
}

const MOCK_CHECK_RESPONSE: CheckResponse = {
  matches: [
    {
      jurisdiction: 'US',
      wordmark: 'NIKE',
      matched_text: 'nike',
      serial_number: '73006089',
      registration_number: '0978952',
      international_class: '025',
      owner: 'Nike, Inc.',
      status: 'LIVE',
      status_code: '700',
      registration_status: 'registered',
      filing_date: '1970-02-18',
      confidence: 'high',
      tsdr_url: 'https://tsdr.uspto.gov/#caseNumber=73006089&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch',
    },
  ],
  total_matches: 1,
  truncated: false,
  query_time_ms: 42,
  text_length: 4,
  data_last_synced: '2025-01-15T03:00:00Z',
  data_stale: false,
  jurisdictions_requested: ['US'],
  jurisdictions_checked: ['US'],
  official_lookup_actions: [],
};

const MOCK_BATCH_RESPONSE: BatchResponse = {
  results: [
    {
      index: 0,
      matches: MOCK_CHECK_RESPONSE.matches,
      total_matches: 1,
      query_time_ms: 42,
      jurisdictions_requested: ['US'],
      jurisdictions_checked: ['US'],
      official_lookup_actions: [],
      data_stale: false,
    },
  ],
  total_query_time_ms: 42,
  data_last_synced: '2025-01-15T03:00:00Z',
};

const MOCK_HEALTH_RESPONSE: HealthResponse = {
  status: 'ok',
  version: 'v1',
  database: 'connected',
  last_sync: {
    jurisdiction: 'US',
    source: 'uspto',
    source_updated_at: '2025-01-15T03:00:00Z',
    date: '2025-01-15',
    status: 'completed',
    live_mark_count: 4_000_000,
    marks_added: 120,
    marks_updated: 45,
  },
  jurisdictions: [
    {
      jurisdiction: 'US',
      status: 'completed',
      source: 'uspto',
      last_synced_at: '2025-01-15T03:00:00Z',
      source_updated_at: '2025-01-15T03:00:00Z',
      sync_date: '2025-01-15',
      live_mark_count: 4_000_000,
      data_stale: false,
      freshness_max_age_hours: 48,
      local_database: true,
    },
  ],
  data_stale: false,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryAfter?: number
): Response {
  const body = {
    error: {
      code,
      message,
      ...(retryAfter !== undefined && { retry_after: retryAfter }),
    },
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (retryAfter !== undefined) {
    headers['Retry-After'] = String(retryAfter);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Trigger 3 consecutive 5xx failures on a checker instance to open the
 * circuit breaker. Each 5xx call triggers a retry (2 fetches per call),
 * with a 2s delay between. Fake timers must be active.
 */
async function openCircuit(
  checker: TrademarkChecker,
  fetchSpy: ReturnType<typeof vi.spyOn>
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fetchSpy.mockResolvedValueOnce(
      errorResponse(500, 'INTERNAL_ERROR', `Fail ${i + 1}`)
    );
    fetchSpy.mockResolvedValueOnce(
      errorResponse(500, 'INTERNAL_ERROR', `Fail ${i + 1} retry`)
    );

    // Immediately attach catch handler so the rejection is never unhandled
    const settled = safeCheck(checker, { text: 'test', classes: ['025'] });
    // Advance past the 2s retry delay
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await settled;
    expect(result).toBeInstanceOf(TrademarkCheckerError);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrademarkChecker', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // check()
  // -----------------------------------------------------------------------
  describe('check()', () => {
    it('defaults to the local dev API URL when no baseUrl is given', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const checker = new TrademarkChecker({ apiKey: 'test-api-key-token' });

      await checker.check({ text: 'nike shoes', classes: ['025'] });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3000/api/v1/check');
    });

    it('sends a correct POST request with auth header and body', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const checker = createChecker();

      const result = await checker.check({
        text: 'nike shoes',
        classes: ['025'],
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.example.com/api/v1/check');
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-api-key-token');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({ text: 'nike shoes', classes: ['025'] });

      expect(result).toEqual(MOCK_CHECK_RESPONSE);
    });

    it('sends request without Authorization header when no apiKey is set', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const checker = new TrademarkChecker({ baseUrl: 'https://test.example.com' });

      await checker.check({ text: 'test', classes: ['025'] });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('passes include_dead in the request body', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const checker = createChecker();

      await checker.check({ text: 'test', classes: ['025'], include_dead: true });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.include_dead).toBe(true);
    });

    it('throws TrademarkCheckerError on 400 client error', async () => {
      fetchSpy.mockResolvedValueOnce(
        errorResponse(400, 'INVALID_TEXT_LENGTH', 'Text too short')
      );
      const checker = createChecker();

      const result = await safeCheck(checker, { text: '', classes: ['025'] });
      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('INVALID_TEXT_LENGTH');
      expect(error.message).toBe('Text too short');
    });
  });

  // -----------------------------------------------------------------------
  // checkBatch()
  // -----------------------------------------------------------------------
  describe('checkBatch()', () => {
    it('sends a correct batch POST request', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_BATCH_RESPONSE));
      const checker = createChecker();

      const result = await checker.checkBatch({
        items: [{ text: 'nike shoes', classes: ['025'] }],
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.example.com/api/v1/check/batch');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        items: [{ text: 'nike shoes', classes: ['025'] }],
      });

      expect(result).toEqual(MOCK_BATCH_RESPONSE);
    });
  });

  // -----------------------------------------------------------------------
  // health()
  // -----------------------------------------------------------------------
  describe('health()', () => {
    it('sends a GET request to /api/v1/health', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_HEALTH_RESPONSE));
      const checker = createChecker();

      const result = await checker.health();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.example.com/api/v1/health');
      expect(init.method).toBe('GET');
      expect(result).toEqual(MOCK_HEALTH_RESPONSE);
    });
  });

  // -----------------------------------------------------------------------
  // Retry on 5xx
  // -----------------------------------------------------------------------
  describe('retry on 5xx', () => {
    it('retries once after 2 seconds when the first request returns 500', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fetchSpy
        .mockResolvedValueOnce(errorResponse(500, 'INTERNAL_ERROR', 'Server error'))
        .mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));

      const checker = createChecker();
      const settled = safeCheck(checker, { text: 'test', classes: ['025'] });

      await vi.advanceTimersByTimeAsync(2_100);
      const result = await settled;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual(MOCK_CHECK_RESPONSE);
    });

    it('throws after the retry also returns 5xx', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fetchSpy
        .mockResolvedValueOnce(errorResponse(503, 'DB_UNAVAILABLE', 'DB down'))
        .mockResolvedValueOnce(errorResponse(503, 'DB_UNAVAILABLE', 'DB still down'));

      const checker = createChecker();
      const settled = safeCheck(checker, { text: 'test', classes: ['025'] });

      await vi.advanceTimersByTimeAsync(2_100);
      const result = await settled;

      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('DB_UNAVAILABLE');
      expect(error.message).toBe('DB still down');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Respect Retry-After on 429
  // -----------------------------------------------------------------------
  describe('429 rate limiting', () => {
    it('throws TrademarkCheckerError with retryAfter from Retry-After header', async () => {
      fetchSpy.mockResolvedValueOnce(
        errorResponse(429, 'RATE_LIMITED', 'Too many requests', 30)
      );

      const checker = createChecker();
      const result = await safeCheck(checker, { text: 'test', classes: ['025'] });

      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryAfter).toBe(30);
    });

    it('does not retry on 429 (only retries on 5xx)', async () => {
      fetchSpy.mockResolvedValueOnce(
        errorResponse(429, 'RATE_LIMITED', 'Too many requests', 30)
      );

      const checker = createChecker();
      const result = await safeCheck(checker, { text: 'test', classes: ['025'] });

      expect(result).toBeInstanceOf(TrademarkCheckerError);
      // Should NOT retry -- only one fetch call
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------
  describe('circuit breaker', () => {
    it('opens after 3 consecutive failures and rejects immediately', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const checker = createChecker();

      // Fail 3 times to open the circuit
      await openCircuit(checker, fetchSpy);

      // 4th call should fail immediately with CIRCUIT_OPEN (no fetch at all)
      const result = await safeCheck(checker, { text: 'test', classes: ['025'] });
      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('CIRCUIT_OPEN');
      expect(error.retryAfter).toBeGreaterThan(0);
    });

    it('does NOT open the circuit on 4xx client errors (regression: 429s wedged it open)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const checker = createChecker();

      // Five rate-limit responses in a row — the backend is UP and answering, so
      // the breaker must stay closed (previously three 429s tripped it for 2 min).
      for (let i = 0; i < 5; i++) {
        fetchSpy.mockResolvedValueOnce(errorResponse(429, 'RATE_LIMITED', 'Too many', 1));
        const r = await safeCheck(checker, { text: 'test', classes: ['025'] });
        expect((r as TrademarkCheckerError).code).toBe('RATE_LIMITED');
      }

      // A subsequent call still reaches the network (circuit closed), not CIRCUIT_OPEN.
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const ok = await checker.check({ text: 'test', classes: ['025'] });
      expect(ok).toEqual(MOCK_CHECK_RESPONSE);
    });

    it('transitions to half-open after 2 minutes and allows a probe', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const checker = createChecker();

      // Open the circuit with 3 failures
      await openCircuit(checker, fetchSpy);

      // Advance time past the 2-minute open duration
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      // Next call should go through (half-open probe)
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const result = await checker.check({ text: 'test', classes: ['025'] });
      expect(result).toEqual(MOCK_CHECK_RESPONSE);
    });

    it('resets to closed after a successful probe in half-open state', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const checker = createChecker();

      // Open the circuit
      await openCircuit(checker, fetchSpy);

      // Advance past open duration
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      // Successful probe
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      await checker.check({ text: 'test', classes: ['025'] });

      // Subsequent calls should also succeed (circuit is fully closed)
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_CHECK_RESPONSE));
      const result = await checker.check({ text: 'test', classes: ['025'] });
      expect(result).toEqual(MOCK_CHECK_RESPONSE);
    });

    it('admits only ONE probe when concurrent calls hit half-open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const checker = createChecker();
      await openCircuit(checker, fetchSpy);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      // First probe: a fetch that stays pending, so the probe is in flight.
      let releaseProbe!: (r: Response) => void;
      fetchSpy.mockImplementationOnce(
        () => new Promise<Response>((resolve) => { releaseProbe = resolve; })
      );
      const fetchesBefore = fetchSpy.mock.calls.length;

      const probe = checker.check({ text: 'a', classes: ['025'] }); // becomes the probe
      // A concurrent call while the probe is pending must be rejected, not fetched.
      const blocked = await safeCheck(checker, { text: 'b', classes: ['025'] });
      expect(blocked).toBeInstanceOf(TrademarkCheckerError);
      expect((blocked as TrademarkCheckerError).code).toBe('CIRCUIT_OPEN');
      // Only the single probe hit the network; the concurrent call did not.
      expect(fetchSpy.mock.calls.length).toBe(fetchesBefore + 1);

      // Releasing the probe successfully closes the circuit.
      releaseProbe(jsonResponse(MOCK_CHECK_RESPONSE));
      await expect(probe).resolves.toEqual(MOCK_CHECK_RESPONSE);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------
  describe('timeout', () => {
    it('throws TIMEOUT error when request exceeds timeout', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      fetchSpy.mockImplementationOnce(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }
          })
      );

      const checker = new TrademarkChecker({
        baseUrl: 'https://test.example.com',
        timeoutMs: 10_000,
      });

      // Attach catch immediately to prevent unhandled rejection
      const settled = safeCheck(checker, { text: 'test', classes: ['025'] });

      await vi.advanceTimersByTimeAsync(10_100);

      const result = await settled;
      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('TIMEOUT');
      expect(error.message).toMatch(/timed out/);
    });
  });

  // -----------------------------------------------------------------------
  // Network errors
  // -----------------------------------------------------------------------
  describe('network errors', () => {
    it('wraps fetch network errors in TrademarkCheckerError', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const checker = createChecker();
      const result = await safeCheck(checker, { text: 'test', classes: ['025'] });

      expect(result).toBeInstanceOf(TrademarkCheckerError);
      const error = result as TrademarkCheckerError;
      expect(error.code).toBe('NETWORK_ERROR');
      expect(error.message).toBe('Failed to fetch');
    });
  });

  // -----------------------------------------------------------------------
  // Base URL normalization
  // -----------------------------------------------------------------------
  describe('base URL normalization', () => {
    it('strips trailing slashes from baseUrl', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(MOCK_HEALTH_RESPONSE));
      const checker = new TrademarkChecker({
        baseUrl: 'https://test.example.com/',
      });

      await checker.health();

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.example.com/api/v1/health');
    });
  });
});
