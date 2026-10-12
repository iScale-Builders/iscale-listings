/** Error codes returned by the Trademark Checker API. */
export type TrademarkErrorCode =
  | 'INVALID_TEXT_LENGTH'
  | 'INVALID_TEXT_CONTENT'
  | 'INVALID_CLASS'
  | 'UNKNOWN_CLASS'
  | 'BATCH_TOO_LARGE'
  | 'CANDIDATE_OVERFLOW'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'DB_UNAVAILABLE'
  | 'SYNC_STALE'
  | 'QUERY_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CIRCUIT_OPEN';

/**
 * Error thrown by TrademarkChecker methods when an API call fails
 * or a client-side error condition is met (timeout, circuit breaker, etc.).
 */
export class TrademarkCheckerError extends Error {
  /** Machine-readable error code. */
  readonly code: TrademarkErrorCode;
  /** Number of seconds to wait before retrying, if applicable. */
  readonly retryAfter: number | undefined;

  constructor(
    code: TrademarkErrorCode,
    message: string,
    retryAfter?: number
  ) {
    super(message);
    this.name = 'TrademarkCheckerError';
    this.code = code;
    this.retryAfter = retryAfter;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, TrademarkCheckerError.prototype);
  }
}
