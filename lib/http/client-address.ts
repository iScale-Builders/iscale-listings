// This is only called on a trusted-proxy deployment (the middleware gates on
// VERCEL / TRUST_PROXY_HEADERS). Prefer `x-real-ip`: a trusted proxy SETS and
// overwrites it with the real client IP, so the caller cannot forge it. We must
// NOT trust the leftmost `X-Forwarded-For` value — XFF is only appended to, so a
// caller can prefix a forged entry. Trusting the leftmost let an attacker rotate
// it per request to land in a fresh per-IP rate-limit bucket every time and
// bypass throttling entirely.
export function trustedClientAddressFromHeaders(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwardedFor = headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (forwardedFor?.length) {
    // Fallback for a proxy that sets only XFF. Use the RIGHTMOST entry — the
    // address the closest trusted proxy actually observed — not the spoofable
    // leftmost.
    return forwardedFor[forwardedFor.length - 1];
  }

  return 'unknown-client';
}
