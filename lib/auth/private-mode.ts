// Private mode: when REQUIRE_API_KEY=true the API serves ONLY requests that
// carry a valid API key (Jose 2026-10-04: "this is my personal shit, nobody
// should ever hace access to it"). Anonymous calls get 401 on every /api/v1
// route, health included. The data-refresh cron keeps its own secret check.

export function privateModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REQUIRE_API_KEY === 'true';
}

/** True when this request must be refused for lack of a valid API key. */
export function blockedWithoutKey(
  pathname: string,
  authSource: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!privateModeEnabled(env)) return false;
  if (pathname.startsWith('/api/v1/cron/')) return false;
  return authSource !== 'api_key';
}
