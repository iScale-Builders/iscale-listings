// One settings file shared by the Chrome extension (through the local helper)
// and the `iscale` CLI, so a prompt edited in the extension is the prompt the
// CLI uses. It never holds secrets: API keys stay in Chrome local storage or in
// the user's environment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SETTINGS_TYPE = 'iscale-listings-settings';
export const SETTINGS_SCHEMA = 1;

/** Non-secret preferences the extension and CLI share. Anything else is dropped. */
const PREF_TYPES = {
  provider: 'string',
  localEngine: 'string',
  localModel: 'string',
  openaiModel: 'string',
  trademarkEnabled: 'boolean',
  tmApiBase: 'string',
  validateEnabled: 'boolean',
  runMode: 'string',
  site: 'string',
  customFields: 'object',
};

export function iscaleHome(env = process.env) {
  return env.ISCALE_HOME || path.join(os.homedir(), '.iscale-listings');
}

export function settingsPath(env = process.env) {
  return path.join(iscaleHome(env), 'settings.json');
}

/** Validate and normalize a settings document. Throws on anything unusable. */
export function normalizeSettings(doc, now = new Date()) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('settings must be an object');
  const config = doc.config;
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.fields)) {
    throw new Error('settings.config must be a listing config with a fields array');
  }
  const prefs = {};
  for (const [key, type] of Object.entries(PREF_TYPES)) {
    const value = doc.prefs?.[key];
    if (value !== undefined && typeof value === type) prefs[key] = value;
  }
  const updatedAt = typeof doc.updatedAt === 'string' && !Number.isNaN(Date.parse(doc.updatedAt))
    ? doc.updatedAt
    : now.toISOString();
  return { type: SETTINGS_TYPE, schema: SETTINGS_SCHEMA, updatedAt, config, prefs };
}

export function readSettings(env = process.env) {
  const file = settingsPath(env);
  if (!fs.existsSync(file)) return null;
  return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Atomic write (temp file + rename) so a crash can't leave half a file. */
export function writeSettings(doc, env = process.env) {
  const normalized = normalizeSettings(doc);
  const file = settingsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, file);
  return normalized;
}
