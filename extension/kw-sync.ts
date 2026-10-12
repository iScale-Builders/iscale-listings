// Shared settings with the iScale local helper, so the CLI and the extension use
// the same prompt rules, presets, fields, trademark classes and banned words.
//
// Only non-secret settings travel: API keys never leave Chrome local storage.
// Newest `updatedAt` wins. When the helper isn't running the extension keeps
// working on its Chrome copy and says so in the settings panel.

import { LOCAL_ENGINES, kw, type KwSite, type LocalEngine } from './kw-state';
import type { ListingConfig, ListingField } from '@/core/types';

export const DEFAULT_HELPER_URL = 'http://127.0.0.1:18799';
const HELPER_TIMEOUT_MS = 1500;

export interface SharedSettings {
  type: 'iscale-listings-settings';
  schema: number;
  updatedAt: string;
  config: ListingConfig;
  prefs: {
    provider?: string;
    localEngine?: string;
    localModel?: string;
    openaiModel?: string;
    trademarkEnabled?: boolean;
    tmApiBase?: string;
    validateEnabled?: boolean;
    runMode?: string;
    site?: string;
    customFields?: ListingField[];
  };
}

export type SyncStatus = 'synced' | 'offline' | 'error' | 'off';

export function helperBase(): string {
  return (kw.codexUrl.trim() || DEFAULT_HELPER_URL).replace(/\/+$/, '');
}

/** The shareable (non-secret) part of the extension's settings. */
export function buildSharedSettings(): SharedSettings {
  return {
    type: 'iscale-listings-settings',
    schema: 1,
    updatedAt: kw.settingsUpdatedAt || new Date().toISOString(),
    config: kw.config,
    prefs: {
      provider: kw.provider,
      localEngine: kw.localEngine,
      localModel: kw.localModel,
      openaiModel: kw.openaiModel,
      trademarkEnabled: kw.trademarkEnabled,
      tmApiBase: kw.tmApiBase,
      validateEnabled: kw.validateEnabled,
      runMode: kw.runMode,
      site: kw.site,
      customFields: kw.customFields,
    },
  };
}

/** True when `remote` is strictly newer than what the extension holds. */
export function isNewer(remote: SharedSettings | null, localUpdatedAt: string): boolean {
  if (!remote?.updatedAt) return false;
  const r = Date.parse(remote.updatedAt);
  const l = Date.parse(localUpdatedAt || '');
  return Number.isFinite(r) && (!Number.isFinite(l) || r > l);
}

/** Fold a helper settings document into `kw`. Unknown/invalid values are ignored. */
export function applySharedSettings(doc: SharedSettings): void {
  if (doc.config && Array.isArray(doc.config.fields)) kw.config = doc.config;
  const p = doc.prefs ?? {};
  if (p.provider === 'codex' || p.provider === 'openai') {
    kw.provider = p.provider;
  }
  if (LOCAL_ENGINES.includes(p.localEngine as LocalEngine)) kw.localEngine = p.localEngine as LocalEngine;
  if (typeof p.localModel === 'string') kw.localModel = p.localModel;
  if (typeof p.openaiModel === 'string') kw.openaiModel = p.openaiModel;
  if (typeof p.trademarkEnabled === 'boolean') kw.trademarkEnabled = p.trademarkEnabled;
  if (typeof p.tmApiBase === 'string') kw.tmApiBase = p.tmApiBase;
  if (typeof p.validateEnabled === 'boolean') kw.validateEnabled = p.validateEnabled;
  if (p.runMode === 'auto' || p.runMode === 'manual') kw.runMode = p.runMode;
  if (p.site === 'none' || p.site === 'amazon-merch' || p.site === 'etsy') kw.site = p.site as KwSite;
  if (Array.isArray(p.customFields) && p.customFields.length) kw.customFields = p.customFields;
  kw.settingsUpdatedAt = doc.updatedAt;
}

/** Import a settings file: the extension's or the CLI's export (config + prefs),
 *  or a bare listing config. Throws on anything without a listing config. */
export function importSettingsDoc(raw: unknown): void {
  const doc = raw as Partial<SharedSettings> & { fields?: unknown };
  const config = doc && typeof doc === 'object' && doc.config ? doc.config : (doc as unknown as ListingConfig);
  if (!config || typeof config !== 'object' || !Array.isArray((config as ListingConfig).fields)) {
    throw new Error('Not an iScale Listings settings file (no listing config found).');
  }
  applySharedSettings({
    type: 'iscale-listings-settings',
    schema: 1,
    updatedAt: new Date().toISOString(),
    config: config as ListingConfig,
    prefs: doc.prefs ?? {},
  });
}

async function helperFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HELPER_TIMEOUT_MS);
  try {
    return await fetch(`${helperBase()}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Iscale-Bridge': '1', ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read the helper's settings: the document, null when it has none yet, or
 *  'offline' when the helper isn't reachable. */
export async function pullSharedSettings(): Promise<SharedSettings | null | 'offline'> {
  try {
    const resp = await helperFetch('/settings');
    if (resp.status === 404) return null;
    if (!resp.ok) return 'offline';
    const doc = (await resp.json()) as SharedSettings;
    return doc && doc.type === 'iscale-listings-settings' ? doc : null;
  } catch {
    return 'offline';
  }
}

export async function pushSharedSettings(): Promise<SyncStatus> {
  try {
    const resp = await helperFetch('/settings', { method: 'PUT', body: JSON.stringify(buildSharedSettings()) });
    return resp.ok ? 'synced' : 'error';
  } catch {
    return 'offline';
  }
}

export function renderSyncStatus(status: SyncStatus): void {
  const node = document.getElementById('kw-sync-status');
  if (!node) return;
  node.textContent =
    status === 'synced'
      ? '✓ Settings shared with the iScale helper (the CLI uses these exact settings).'
      : status === 'offline'
        ? 'iScale helper not running — settings are saved in Chrome only. Run `iscale helper --install` once (or Export / Import) to share them with the CLI.'
        : status === 'off'
          ? 'Automatic sharing is off — use Export / Import to move settings to the CLI.'
          : '⚠ The iScale helper rejected these settings — check its console.';
  node.dataset['status'] = status;
}
