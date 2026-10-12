import { NextRequest, NextResponse } from 'next/server';

// Browser origins allowed to call the API cross-site come ONLY from the
// ALLOWED_ORIGINS env var (comma-separated) — each deployment names its own
// frontends instead of baking hostnames into the code. Localhost is allowed
// only outside production so it can't be used as an allowed origin against a
// live API.
const DEV_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function getAllowedOrigins(): Set<string> {
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const base = process.env.NODE_ENV === 'production' ? [] : DEV_ALLOWED_ORIGINS;

  return new Set([...base, ...fromEnv]);
}

function getAllowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return getAllowedOrigins().has(origin) ? origin : null;
}

export function applyCorsHeaders(
  request: NextRequest,
  response: NextResponse
): NextResponse {
  const allowedOrigin = getAllowedOrigin(request);
  response.headers.set('Vary', 'Origin');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  response.headers.set('Access-Control-Max-Age', '86400');

  if (allowedOrigin) {
    response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  }

  return response;
}

export function createCorsPreflightResponse(request: NextRequest): NextResponse {
  const allowedOrigin = getAllowedOrigin(request);
  if (!allowedOrigin) {
    return NextResponse.json(
      { error: 'Origin not allowed' },
      { status: 403, headers: { Vary: 'Origin' } }
    );
  }

  const response = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(request, response);
}
