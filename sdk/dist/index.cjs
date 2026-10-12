'use strict';

// src/errors.ts
var TrademarkCheckerError = class _TrademarkCheckerError extends Error {
  constructor(code, message, retryAfter) {
    super(message);
    this.name = "TrademarkCheckerError";
    this.code = code;
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, _TrademarkCheckerError.prototype);
  }
};

// src/index.ts
var CIRCUIT_FAILURE_THRESHOLD = 3;
var CIRCUIT_OPEN_DURATION_MS = 2 * 60 * 1e3;
var RETRY_DELAY_MS = 2e3;
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_BASE_URL = "http://localhost:3000";
var TrademarkChecker = class {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuit = {
      state: "closed",
      failureCount: 0,
      openedAt: 0,
      probing: false
    };
  }
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  /** Check a single text for trademark matches. */
  async check(request) {
    return this.request("/api/v1/check", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }
  /** Check multiple texts for trademark matches in a single request. */
  async checkBatch(request) {
    return this.request("/api/v1/check/batch", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }
  /** Check the health of the API and database. */
  async health() {
    return this.request("/api/v1/health", {
      method: "GET"
    });
  }
  // -------------------------------------------------------------------------
  // Internal: request pipeline with resilience
  // -------------------------------------------------------------------------
  async request(path, init) {
    this.assertCircuitNotOpen();
    try {
      const data = await this.fetchWithRetry(path, init);
      this.onSuccess();
      return data;
    } catch (error) {
      if (isCircuitTrippingError(error)) {
        this.onFailure();
      }
      throw error;
    }
  }
  async fetchWithRetry(path, init) {
    const result = await this.doFetch(path, init);
    if (result.status >= 500) {
      await delay(RETRY_DELAY_MS);
      const retryResult = await this.doFetch(path, init);
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
  async doFetch(path, init) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: controller.signal
      });
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : void 0;
      if (!response.ok) {
        let errorBody;
        try {
          errorBody = await response.json();
        } catch {
        }
        return {
          status: response.status,
          data: void 0,
          errorBody,
          retryAfter
        };
      }
      const data = await response.json();
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TrademarkCheckerError(
          "TIMEOUT",
          `Request to ${path} timed out after ${this.timeoutMs}ms`
        );
      }
      if (error instanceof TrademarkCheckerError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new TrademarkCheckerError("NETWORK_ERROR", message);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------
  assertCircuitNotOpen() {
    if (this.circuit.state === "open") {
      const elapsed = Date.now() - this.circuit.openedAt;
      if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
        this.circuit.state = "half-open";
        this.circuit.probing = true;
      } else {
        const remainingSec = Math.ceil(
          (CIRCUIT_OPEN_DURATION_MS - elapsed) / 1e3
        );
        throw new TrademarkCheckerError(
          "CIRCUIT_OPEN",
          `Circuit breaker is open. Retry in ${remainingSec}s.`,
          remainingSec
        );
      }
    } else if (this.circuit.state === "half-open" && this.circuit.probing) {
      throw new TrademarkCheckerError(
        "CIRCUIT_OPEN",
        "Circuit breaker is verifying recovery. Retry shortly.",
        1
      );
    }
  }
  onSuccess() {
    this.circuit = {
      state: "closed",
      failureCount: 0,
      openedAt: 0,
      probing: false
    };
  }
  onFailure() {
    this.circuit.probing = false;
    this.circuit.failureCount += 1;
    if (this.circuit.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuit.state = "open";
      this.circuit.openedAt = Date.now();
    }
  }
  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------
  toError(result) {
    if (result.errorBody?.error) {
      const { code, message, retry_after } = result.errorBody.error;
      return new TrademarkCheckerError(
        code,
        message,
        retry_after ?? result.retryAfter
      );
    }
    if (result.status === 429) {
      return new TrademarkCheckerError(
        "RATE_LIMITED",
        "Rate limit exceeded.",
        result.retryAfter
      );
    }
    if (result.status >= 500) {
      return new TrademarkCheckerError(
        "INTERNAL_ERROR",
        `Server error (HTTP ${result.status}).`
      );
    }
    return new TrademarkCheckerError(
      "INTERNAL_ERROR",
      `Unexpected error (HTTP ${result.status}).`
    );
  }
};
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var CLIENT_ERROR_CODES = /* @__PURE__ */ new Set([
  "INVALID_TEXT_LENGTH",
  "INVALID_TEXT_CONTENT",
  "INVALID_CLASS",
  "UNKNOWN_CLASS",
  "BATCH_TOO_LARGE",
  "CANDIDATE_OVERFLOW",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED"
]);
function isCircuitTrippingError(error) {
  if (error instanceof TrademarkCheckerError) {
    if (error.code === "CIRCUIT_OPEN") return false;
    return !CLIENT_ERROR_CODES.has(error.code);
  }
  return true;
}

exports.TrademarkChecker = TrademarkChecker;
exports.TrademarkCheckerError = TrademarkCheckerError;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map