import { C as CheckerOptions, a as CheckRequest, b as CheckResponse, B as BatchRequest, c as BatchResponse, H as HealthResponse } from './types-C1Llomcy.js';
export { A as ApiErrorBody, d as BatchItem, e as BatchResultItem, f as HighlightOptions, J as JurisdictionCode, g as JurisdictionHealth, O as OfficialLookupAction, S as SyncInfo, T as TrademarkMatch } from './types-C1Llomcy.js';

/** Error codes returned by the Trademark Checker API. */
type TrademarkErrorCode = 'INVALID_TEXT_LENGTH' | 'INVALID_TEXT_CONTENT' | 'INVALID_CLASS' | 'UNKNOWN_CLASS' | 'BATCH_TOO_LARGE' | 'CANDIDATE_OVERFLOW' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'DB_UNAVAILABLE' | 'SYNC_STALE' | 'QUERY_TIMEOUT' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CIRCUIT_OPEN';
/**
 * Error thrown by TrademarkChecker methods when an API call fails
 * or a client-side error condition is met (timeout, circuit breaker, etc.).
 */
declare class TrademarkCheckerError extends Error {
    /** Machine-readable error code. */
    readonly code: TrademarkErrorCode;
    /** Number of seconds to wait before retrying, if applicable. */
    readonly retryAfter: number | undefined;
    constructor(code: TrademarkErrorCode, message: string, retryAfter?: number);
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
declare class TrademarkChecker {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private circuit;
    constructor(options?: CheckerOptions);
    /** Check a single text for trademark matches. */
    check(request: CheckRequest): Promise<CheckResponse>;
    /** Check multiple texts for trademark matches in a single request. */
    checkBatch(request: BatchRequest): Promise<BatchResponse>;
    /** Check the health of the API and database. */
    health(): Promise<HealthResponse>;
    private request;
    private fetchWithRetry;
    private doFetch;
    private assertCircuitNotOpen;
    private onSuccess;
    private onFailure;
    private toError;
}

export { BatchRequest, BatchResponse, CheckRequest, CheckResponse, CheckerOptions, HealthResponse, TrademarkChecker, TrademarkCheckerError, type TrademarkErrorCode };
