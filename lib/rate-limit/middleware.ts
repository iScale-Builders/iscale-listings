import type { AuthContext } from '@/lib/auth/types';

/**
 * Rate limiter with an optional REST-backed store and an in-memory fallback.
 *
 * Production should set RATE_LIMIT_REST_URL and RATE_LIMIT_REST_TOKEN to a
 * Redis-compatible REST endpoint such as Upstash. Local development falls back
 * to process memory.
 */
interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60_000; // 1 minute
const WINDOW_SECONDS = WINDOW_MS / 1000;

// Periodically evict identifiers whose timestamps have all expired so the
// in-memory store cannot grow unbounded in a long-running process. Runs at most
// once per window and only drops entries with no live timestamps, so it never
// changes an active identifier's result.
let lastSweep = 0;
function sweepExpiredEntries(now: number): void {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  const windowStart = now - WINDOW_MS;
  for (const [id, entry] of store) {
    const live = entry.timestamps.filter((t) => t > windowStart);
    if (live.length === 0) {
      store.delete(id);
    } else {
      entry.timestamps = live;
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp (seconds)
  retryAfter?: number; // seconds (only if not allowed)
}

function checkMemoryRateLimit(
  identifier: string,
  limit: number
): RateLimitResult {
  const now = Date.now();
  sweepExpiredEntries(now);
  const windowStart = now - WINDOW_MS;
  const resetAt = Math.ceil((now + WINDOW_MS) / 1000);

  let entry = store.get(identifier);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(identifier, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= limit) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(retryAfter, 1),
    };
  }

  // Consume a token
  entry.timestamps.push(now);

  return {
    allowed: true,
    limit,
    remaining: limit - entry.timestamps.length,
    resetAt,
  };
}

interface RestCommandResult {
  result?: unknown;
  error?: string;
}

function getRateLimitRestConfig(): { url: string; token: string } | null {
  const url = process.env.RATE_LIMIT_REST_URL?.replace(/\/+$/, '');
  const token = process.env.RATE_LIMIT_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function checkRestRateLimit(
  identifier: string,
  limit: number
): Promise<RateLimitResult> {
  const config = getRateLimitRestConfig();
  if (!config) {
    return checkMemoryRateLimit(identifier, limit);
  }

  const now = Date.now();
  const resetAt = Math.ceil((now + WINDOW_MS) / 1000);
  const key = `rl:${identifier}:${Math.floor(now / WINDOW_MS)}`;

  try {
    const response = await fetch(`${config.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(WINDOW_SECONDS)],
      ]),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Rate limit store returned HTTP ${response.status}`);
    }

    const results = (await response.json()) as RestCommandResult[];
    const count = Number(results[0]?.result ?? 0);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error('Rate limit store returned an invalid count');
    }

    if (count > limit) {
      const retryAfter = Math.max(1, resetAt - Math.ceil(now / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfter,
      };
    }

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  } catch (error) {
    console.error('Rate limit store unavailable.', error);
    // Default degrades to per-instance in-memory limiting. On serverless that is
    // weaker than the shared store (each instance keeps its own counter), so a
    // deploy that prefers stricter limiting during an outage can set
    // RATE_LIMIT_FAIL_CLOSED to reject instead — trading availability for safety.
    const failClosed =
      process.env.RATE_LIMIT_FAIL_CLOSED === 'true' || process.env.VERCEL === '1';
    if (failClosed) {
      const retryAfter = Math.max(1, resetAt - Math.ceil(now / 1000));
      return { allowed: false, limit, remaining: 0, resetAt, retryAfter };
    }
    return checkMemoryRateLimit(identifier, limit);
  }
}

/**
 * Check and consume a rate limit token.
 */
export async function checkRateLimit(
  identifier: string,
  limit: number
): Promise<RateLimitResult> {
  return checkRestRateLimit(identifier, limit);
}

/**
 * Get the rate limit identifier for a given auth context and request.
 */
export function getRateLimitKey(
  auth: AuthContext,
  ip: string
): string {
  if (auth.userId) {
    return `rl:user:${auth.userId}`;
  }
  // Anonymous: use hashed IP
  return `rl:ip:${ip}`;
}

/**
 * Build rate limit response headers.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };

  if (!result.allowed && result.retryAfter) {
    headers['Retry-After'] = String(result.retryAfter);
  }

  return headers;
}
