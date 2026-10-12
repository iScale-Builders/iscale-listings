// The trademark API key for a private deployment (REQUIRE_API_KEY=true).
// TRADEMARK_API_KEY wins; otherwise the machine-local key file
// ~/.iscale-listings/trademark-api-key (never in a repo, never printed). The
// canonical copy lives in the org credentials store.

import fs from 'node:fs';
import path from 'node:path';
import { iscaleHome } from './settings-store.mjs';

export function apiKeyPath(env = process.env) {
  return path.join(iscaleHome(env), 'trademark-api-key');
}

/** @returns {string | null} */
export function trademarkApiKey(env = process.env) {
  const fromEnv = (env.TRADEMARK_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs.readFileSync(apiKeyPath(env), 'utf8').trim();
    return fromFile || null;
  } catch {
    return null;
  }
}
