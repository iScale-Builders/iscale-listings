import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiKeysUnavailableError, getApiKeyCredential, resolveAuth } from '@/lib/auth/middleware';
import { sha256Hex } from '@/lib/auth/api-keys';
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitHeaders,
} from '@/lib/rate-limit/middleware';
import { createErrorResponse } from '@/lib/errors';
import {
  applyCorsHeaders,
  createCorsPreflightResponse,
} from '@/lib/http/cors';
import { trustedClientAddressFromHeaders } from '@/lib/http/client-address';
import { blockedWithoutKey } from '@/lib/auth/private-mode';

function preAuthLimit(): number {
  const n = Number(process.env.PRE_AUTH_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 600;
}

// Keys that recently resolved as valid skip the pre-auth throttle: it exists to
// shield the api_keys lookup from floods of BAD credentials, and behind a reverse
// proxy every caller can share one address bucket, so one busy legitimate client
// (a whole-shop scan) would otherwise lock out every other client. Each request is
// still fully authenticated and limited by the key's own rate limit; a revoked key
// stops working at once (the lookup still runs), it just pays no pre-auth toll.
const VALID_KEY_TTL_MS = 10 * 60_000;
const recentlyValidKeys = new Map<string, number>();
function isRecentlyValid(hash: string | null, now: number): boolean {
  if (!hash) return false;
  const until = recentlyValidKeys.get(hash);
  if (until && until > now) return true;
  if (until) recentlyValidKeys.delete(hash);
  return false;
}

async function hashIp(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function getClientAddress(request: NextRequest): string {
  const isTrustedProxy =
    process.env.VERCEL === '1' ||
    process.env.TRUST_PROXY_HEADERS === 'true';

  if (!isTrustedProxy) {
    return 'local-anonymous';
  }

  return trustedClientAddressFromHeaders(request.headers);
}

function rateLimitedResponse(request: NextRequest, result: Awaited<ReturnType<typeof checkRateLimit>>) {
  const response = createErrorResponse(
    'RATE_LIMITED',
    `Too many requests. Try again in ${result.retryAfter} seconds.`,
    result.retryAfter
  );
  for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
    response.headers.set(name, value);
  }
  return applyCorsHeaders(request, response);
}

// The API is anonymous by default; an optional `X-API-Key` (resolved against the
// api_keys table) raises the tier/limits for self-hosters who provision one. There
// are no user accounts or sessions — auth is API key → anonymous.
export default async function middleware(request: NextRequest) {
  // `config.matcher` scopes this middleware to /api/v1/* only.
  if (request.method === 'OPTIONS') {
    return createCorsPreflightResponse(request);
  }

  const isHealth = request.nextUrl.pathname === '/api/v1/health';
  const clientAddress = getClientAddress(request);
  const hashedIp = await hashIp(clientAddress);

  // Cheap pre-auth throttle protects the API-key lookup from invalid credential
  // floods before any database-backed auth resolution.
  const credential = getApiKeyCredential(request);
  const credentialHash = credential ? await sha256Hex(credential) : null;
  if (!isRecentlyValid(credentialHash, Date.now())) {
    const preAuthResult = await checkRateLimit(`preauth:${hashedIp}`, preAuthLimit());
    if (!preAuthResult.allowed) {
      return rateLimitedResponse(request, preAuthResult);
    }
  }

  let authCtx;
  try {
    authCtx = await resolveAuth(request);
  } catch (error) {
    if (error instanceof ApiKeysUnavailableError) {
      return applyCorsHeaders(
        request,
        createErrorResponse('DB_UNAVAILABLE', 'Authentication service unavailable.')
      );
    }
    throw error;
  }

  if (credentialHash && authCtx.source === 'api_key') {
    recentlyValidKeys.set(credentialHash, Date.now() + VALID_KEY_TTL_MS);
  }

  // Private mode (REQUIRE_API_KEY=true): no valid API key, no access.
  if (blockedWithoutKey(request.nextUrl.pathname, authCtx.source)) {
    return applyCorsHeaders(request, createErrorResponse('UNAUTHORIZED', 'An API key is required.'));
  }

  const key = getRateLimitKey(authCtx, hashedIp);
  const limit = isHealth ? 120 : authCtx.rateLimit;
  const result = await checkRateLimit(key, limit);
  if (!result.allowed) {
    return rateLimitedResponse(request, result);
  }

  // Pass trusted auth context to API routes via request header overrides.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-auth-tier', authCtx.tier);
  requestHeaders.set('x-auth-source', authCtx.source);
  if (authCtx.userId) {
    requestHeaders.set('x-auth-user-id', authCtx.userId);
  } else {
    requestHeaders.delete('x-auth-user-id');
  }
  if (authCtx.apiKeyId !== undefined) {
    requestHeaders.set('x-auth-api-key-id', String(authCtx.apiKeyId));
  } else {
    requestHeaders.delete('x-auth-api-key-id');
  }
  if (authCtx.keyPrefix) {
    requestHeaders.set('x-auth-key-prefix', authCtx.keyPrefix);
  } else {
    requestHeaders.delete('x-auth-key-prefix');
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
    response.headers.set(name, value);
  }

  return applyCorsHeaders(request, response);
}

export const config = {
  matcher: ['/api/v1/:path*'],
  // Node runtime: the API-key lookup may use the plain-PostgreSQL driver (pg),
  // which the Edge runtime cannot load.
  runtime: 'nodejs',
};
