import { NextResponse } from 'next/server';

export const ErrorCodes = {
  INVALID_TEXT_LENGTH: 'INVALID_TEXT_LENGTH',
  INVALID_TEXT_CONTENT: 'INVALID_TEXT_CONTENT',
  INVALID_CLASS: 'INVALID_CLASS',
  UNKNOWN_CLASS: 'UNKNOWN_CLASS',
  INVALID_PARAM: 'INVALID_PARAM',
  INVALID_JSON: 'INVALID_JSON',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  CANDIDATE_OVERFLOW: 'CANDIDATE_OVERFLOW',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  SYNC_STALE: 'SYNC_STALE',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retry_after?: number;
  };
}

const STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_TEXT_LENGTH: 400,
  INVALID_TEXT_CONTENT: 400,
  INVALID_CLASS: 400,
  UNKNOWN_CLASS: 400,
  INVALID_PARAM: 400,
  INVALID_JSON: 400,
  BATCH_TOO_LARGE: 400,
  CANDIDATE_OVERFLOW: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  DB_UNAVAILABLE: 503,
  SYNC_STALE: 503,
  QUERY_TIMEOUT: 504,
};

/** Parse a JSON request body; a malformed body is the caller's fault (400), not a 500. */
export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse<ErrorBody> }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: createErrorResponse(ErrorCodes.INVALID_JSON, 'Request body must be valid JSON.'),
    };
  }
}

export function createErrorResponse(
  code: ErrorCode,
  message: string,
  retryAfter?: number
): NextResponse<ErrorBody> {
  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(retryAfter !== undefined && { retry_after: retryAfter }),
    },
  };

  const status = STATUS_MAP[code];
  const headers: Record<string, string> = {};

  if (code === 'RATE_LIMITED' && retryAfter !== undefined) {
    headers['Retry-After'] = String(retryAfter);
  }

  return NextResponse.json(body, { status, headers });
}
