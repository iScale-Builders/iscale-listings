import { TrademarkCheckerError } from './errors.js';
import type { TrademarkErrorCode } from './errors.js';
import type {
  CheckerOptions,
  CheckRequest,
  CheckResponse,
  BatchRequest,
  BatchResponse,
  HealthResponse,
  ApiErrorBody,
} from './types.js';

export { TrademarkCheckerError } from './errors.js';
export type { TrademarkErrorCode } from './errors.js';
export type {
  CheckerOptions,
  CheckRequest,
  CheckResponse,
  BatchRequest,
  BatchResponse,
  BatchItem,
  BatchResultItem,
  JurisdictionCode,
  JurisdictionHealth,
  OfficialLookupAction,
  TrademarkMatch,
  HealthResponse,
  SyncInfo,
  ApiErrorBody,
  HighlightOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Circuit breaker configuration
// ---------------------------------------------------------------------------
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 2 * 60 * 1000; // 2 minutes
const RETRY_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10_000;
// Default to a local dev deployment — point at your own hosted API via the
// `baseUrl` constructor option.
const DEFAULT_BASE_URL = 'http://localhost:3000';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  openedAt: number;
  /** True while a single half-open probe is in flight — blocks concurrent probes
   *  so a still-down backend gets ONE trial request, not a thundering herd. */
  probing: boolean;
}

/**
 * Lightweight client for the iScaleListings API.
 *
 * Features:
 * - 10 s fetch timeout (configurable)
 * - Circuit breaker: 3 consecutive failures opens the circuit for 2 minutes
 * - Automatic retry once on 5xx after 2 seconds
 * - Respects Retry-After header on 429 responses
 */
export class TrademarkChecker {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private circuit: CircuitBreaker;

  constructor(options: CheckerOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuit = {
      state: 'closed',
      failureCount: 0,
      openedAt: 0,
      probing: false,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Check a single text for trademark matches. */
  async check(request: CheckRequest): Promise<CheckResponse> {
    return this.request<CheckResponse>('/api/v1/check', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** Check multiple texts for trademark matches in a single request. */
  async checkBatch(request: BatchRequest): Promise<BatchResponse> {
    return this.request<BatchResponse>('/api/v1/check/batch', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** Check the health of the API and database. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/v1/health', {
      method: 'GET',
    });
  }

  // -------------------------------------------------------------------------
  // Internal: request pipeline with resilience
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    init: RequestInit
  ): Promise<T> {
    this.assertCircuitNotOpen();

    try {
      const data = await this.fetchWithRetry<T>(path, init);
      this.onSuccess();
      return data;
    } catch (error: unknown) {
      // Only infrastructure failures (network down, timeout, 5xx) should trip the
      // breaker. A 4xx client error (validation, auth, rate-limit) means the
      // backend is UP and answering — counting those let three bad or
      // rate-limited requests wedge the SDK open for two minutes.
      if (isCircuitTrippingError(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  private async fetchWithRetry<T>(
    path: string,
    init: RequestInit
  ): Promise<T> {
    const result = await this.doFetch<T>(path, init);

    // If we got a 5xx, retry exactly once after 2 seconds
    if (result.status >= 500) {
      await delay(RETRY_DELAY_MS);
      const retryResult = await this.doFetch<T>(path, init);
      if (retryResult.status >= 400) {
        throw this.toError(retryResult);
      }
      return retryResult.data;
    }

    if (result.status >= 400) {
      throw this.toError(result);
    }

    return result.data;
  }

  private async doFetch<T>(
    path: string,
    init: RequestInit
  ): Promise<FetchResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });

      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : undefined;

      if (!response.ok) {
        let errorBody: ApiErrorBody | undefined;
        try {
          errorBody = (await response.json()) as ApiErrorBody;
        } catch {
          // Response body was not valid JSON -- we handle it below.
        }

        return {
          status: response.status,
          data: undefined as never,
          errorBody,
          retryAfter,
        };
      }

      const data = (await response.json()) as T;
      return { status: response.status, data };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TrademarkCheckerError(
          'TIMEOUT',
          `Request to ${path} timed out after ${this.timeoutMs}ms`
        );
      }
      if (error instanceof TrademarkCheckerError) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : 'Unknown network error';
      throw new TrademarkCheckerError('NETWORK_ERROR', message);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  private assertCircuitNotOpen(): void {
    if (this.circuit.state === 'open') {
      const elapsed = Date.now() - this.circuit.openedAt;
      if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
        // Transition to half-open and admit exactly ONE probe.
        this.circuit.state = 'half-open';
        this.circuit.probing = true;
      } else {
        const remainingSec = Math.ceil(
          (CIRCUIT_OPEN_DURATION_MS - elapsed) / 1000
        );
        throw new TrademarkCheckerError(
          'CIRCUIT_OPEN',
          `Circuit breaker is open. Retry in ${remainingSec}s.`,
          remainingSec
        );
      }
    } else if (this.circuit.state === 'half-open' && this.circuit.probing) {
      // A probe is already in flight — reject concurrent callers until it
      // resolves, so a still-down backend gets one trial request, not a burst.
      throw new TrademarkCheckerError(
        'CIRCUIT_OPEN',
        'Circuit breaker is verifying recovery. Retry shortly.',
        1
      );
    }
  }

  private onSuccess(): void {
    this.circuit = {
      state: 'closed',
      failureCount: 0,
      openedAt: 0,
      probing: false,
    };
  }

  private onFailure(): void {
    this.circuit.probing = false; // a failed probe frees the half-open gate (and re-opens below)
    this.circuit.failureCount += 1;
    if (this.circuit.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuit.state = 'open';
      this.circuit.openedAt = Date.now();
    }
  }

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  private toError(result: FetchResult<unknown>): TrademarkCheckerError {
    if (result.errorBody?.error) {
      const { code, message, retry_after } = result.errorBody.error;
      return new TrademarkCheckerError(
        code as TrademarkCheckerError['code'],
        message,
        retry_after ?? result.retryAfter
      );
    }

    // Fallback for non-JSON error responses
    if (result.status === 429) {
      return new TrademarkCheckerError(
        'RATE_LIMITED',
        'Rate limit exceeded.',
        result.retryAfter
      );
    }

    if (result.status >= 500) {
      return new TrademarkCheckerError(
        'INTERNAL_ERROR',
        `Server error (HTTP ${result.status}).`
      );
    }

    return new TrademarkCheckerError(
      'INTERNAL_ERROR',
      `Unexpected error (HTTP ${result.status}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchResult<T> {
  status: number;
  data: T;
  errorBody?: ApiErrorBody;
  retryAfter?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 4xx client errors mean the backend is healthy and answering, so they must NOT
 *  trip the circuit breaker — only network errors, timeouts, and 5xx should.
 *  Anything unrecognized trips too, so an unknown failure still backs off. */
const CLIENT_ERROR_CODES: ReadonlySet<TrademarkErrorCode> = new Set<TrademarkErrorCode>([
  'INVALID_TEXT_LENGTH',
  'INVALID_TEXT_CONTENT',
  'INVALID_CLASS',
  'UNKNOWN_CLASS',
  'BATCH_TOO_LARGE',
  'CANDIDATE_OVERFLOW',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
]);

function isCircuitTrippingError(error: unknown): boolean {
  if (error instanceof TrademarkCheckerError) {
    if (error.code === 'CIRCUIT_OPEN') return false; // never self-trip
    return !CLIENT_ERROR_CODES.has(error.code);
  }
  return true; // unknown / non-SDK error → treat as an infrastructure failure
}
