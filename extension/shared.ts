// Shared types + helpers for the extension's three surfaces (content script,
// side panel, keyword pipeline). Each esbuild entry bundles its own copy — this
// file exists to keep ONE definition in source, not to share at runtime.

import { isFamousSingleWordBrand } from '../listing-core-runtime/src/core/listing/famousSingleWordPolicy';

// ---------------------------------------------------------------------------
// API types (mirror the trademark /check response)
// ---------------------------------------------------------------------------

export interface TrademarkMatch {
  readonly wordmark: string;
  readonly matched_text: string;
  readonly serial_number: string;
  readonly registration_number?: string | null;
  readonly international_class: string;
  readonly owner: string | null;
  readonly status: string;
  readonly registration_status?: string;
  readonly jurisdiction?: string;
  readonly filing_date?: string | null;
  readonly confidence: 'high' | 'low';
  readonly tsdr_url: string;
}

export interface CheckResponse {
  readonly matches: TrademarkMatch[];
  readonly total_matches: number;
  readonly truncated: boolean;
  readonly data_stale?: boolean;
  readonly jurisdictions_checked?: readonly string[];
}

/** Requested jurisdictions the API did NOT search. A response that omits
 *  `jurisdictions_checked` counts as none searched — the same fail-loud rule as
 *  the core CLI (trademarkCheck.ts), so a partial screen never reads as clear. */
export function uncheckedJurisdictions(
  data: Pick<CheckResponse, 'jurisdictions_checked'>,
  requested: readonly string[]
): string[] {
  const checked = Array.isArray(data.jurisdictions_checked) ? data.jurisdictions_checked : [];
  return requested.filter((j) => !checked.includes(j));
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const HIDE_SINGLE_KEY = 'itm_hide_single';
export const MODE_KEY = 'itm_mode';
export const STATUS_VISIBILITY_KEY = 'itm_status_visibility';
export type TrademarkJurisdiction = 'US' | 'EUIPO';
export const JURISDICTIONS: readonly TrademarkJurisdiction[] = ['US', 'EUIPO'];
/** Which registries to screen (shared by page scans, selection checks, Keywords). */
export const JURISDICTIONS_KEY = 'itm_jurisdictions';
export const JURISDICTION_OPTIONS: readonly { id: string; label: string; value: readonly TrademarkJurisdiction[] }[] = [
  { id: 'both', label: 'US + EU', value: ['US', 'EUIPO'] },
  { id: 'us', label: 'US only', value: ['US'] },
  { id: 'eu', label: 'EU only', value: ['EUIPO'] },
];

/** Known registry codes only, canonical order; empty/garbage = US + EU. */
export function normalizeJurisdictions(value: unknown): TrademarkJurisdiction[] {
  const wanted = new Set(
    (Array.isArray(value) ? value : [])
      .map((v) => String(v).trim().toUpperCase())
      .map((v) => (v === 'EU' ? 'EUIPO' : v))
  );
  const picked = JURISDICTIONS.filter((j) => wanted.has(j));
  return picked.length ? [...picked] : [...JURISDICTIONS];
}

/** Public EUIPO eSearch record for an EU trade mark number (hash route; the
 *  old /en/search-ip/trademarks/<n> path 404s). Pads to 9 digits. */
export function euipoTrademarkUrl(serial: string | null | undefined): string {
  const raw = String(serial ?? '').trim();
  if (!raw) return '';
  const n = /^\d{1,9}$/.test(raw) ? raw.padStart(9, '0') : raw;
  return `https://euipo.europa.eu/eSearch/#details/trademarks/${encodeURIComponent(n)}`;
}

/** The official record link for a match. EU marks are always rebuilt from the
 *  serial (so an older API that still emits the broken EUIPO path is corrected
 *  client-side); US marks use the API's tsdr_url, else a TSDR link from serial. */
export function trademarkRecordUrl(m: {
  jurisdiction?: string | null;
  serial_number?: string | null;
  tsdr_url?: string | null;
}): string {
  if ((m.jurisdiction ?? '').toUpperCase() === 'EUIPO') return euipoTrademarkUrl(m.serial_number);
  const api = safeHttpUrl(m.tsdr_url);
  if (api) return api;
  return m.serial_number
    ? `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(m.serial_number)}&caseType=SERIAL_NO&searchType=statusSearch`
    : '';
}

/** Scan scope. 'any' = whole page; marketplace modes read listing/product text only. */
export type ScanMode = 'any' | 'amazon' | 'etsy';

export type StatusVisibility = Record<'live' | 'pending' | 'dead', boolean>;

export const DEFAULT_STATUS_VISIBILITY: StatusVisibility = {
  live: true,
  pending: true,
  dead: true,
};

export function normalizeStatusVisibility(raw: unknown): StatusVisibility {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATUS_VISIBILITY };
  const value = raw as Partial<Record<keyof StatusVisibility, unknown>>;
  return {
    live: typeof value.live === 'boolean' ? value.live : true,
    pending: typeof value.pending === 'boolean' ? value.pending : true,
    dead: typeof value.dead === 'boolean' ? value.dead : true,
  };
}

// ---------------------------------------------------------------------------
// Single-word marks (DESIGN, SHIRT, LOVE…) are the noisy case — demoted to a
// "faint" tier and hideable via the panel toggle.
// ---------------------------------------------------------------------------

export function isSingleWord(m: TrademarkMatch): boolean {
  return m.wordmark.trim().split(/\s+/).length === 1;
}

export function isFamousSingleWord(m: TrademarkMatch): boolean {
  return isFamousSingleWordBrand(m.wordmark);
}

/** Visual tier for a match: single-word marks demote to "faint". */
export function tierOf(m: TrademarkMatch): 'high' | 'low' | 'faint' {
  return isSingleWord(m) && !isFamousSingleWord(m) ? 'faint' : m.confidence;
}

/** Matches actually shown given the single-word toggle. */
export function displayMatches(
  matches: readonly TrademarkMatch[],
  hideSingle: boolean
): TrademarkMatch[] {
  return hideSingle
    ? matches.filter((m) => !isSingleWord(m) || isFamousSingleWord(m))
    : matches.slice();
}

// ---------------------------------------------------------------------------
// DOM + tab helpers
// ---------------------------------------------------------------------------

/** Escape text for safe interpolation into innerHTML. NOTE: does NOT escape
 *  quotes — use escAttr() for HTML *attribute* values. */
export function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

/** Escape for an HTML attribute value (adds the quote-escaping escapeHtml omits),
 *  so untrusted data interpolated into `attr="..."` can't break out of the quotes. */
export function escAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Return the URL only if it's a safe http(s) link, else '' — blocks `javascript:`
 *  and `data:` hrefs from a poisoned/odd trademark-API `tsdr_url`. */
export function safeHttpUrl(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? u : '';
  } catch {
    return '';
  }
}

/** Active tab id in the current window (panel context; null if unavailable). */
export async function activeTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// chrome.storage — best-effort (storage is optional in some contexts).
//
// Two areas are used deliberately:
//   • sync  — tiny, non-secret UI prefs (single-word toggle, scan mode, status
//             filters). Small enough to never approach the 8 KB/item or
//             ~120-writes/min sync quotas, and nice to roam across machines.
//   • local — API keys (NEVER upload secrets to the Google account) and the
//             bulky keyword config / presets (no 8 KB/item cap). See kw-state.
// Both write paths surface `runtime.lastError` instead of swallowing it, so a
// failed write can't silently look applied and then vanish on the next open.
// ---------------------------------------------------------------------------

export function storageGet(keys: string[], cb: (r: Record<string, unknown>) => void): void {
  try {
    chrome.storage?.sync?.get?.(keys, cb);
  } catch {
    /* storage optional */
  }
}

/** Write to sync storage, reporting any quota / write error via the optional
 *  callback (and console) rather than swallowing it. */
export function storageSet(obj: Record<string, unknown>, cb?: (err: unknown) => void): void {
  try {
    chrome.storage?.sync?.set?.(obj, () => {
      const err = chrome.runtime?.lastError ?? null;
      if (err) console.warn('[iscale] storage.sync write failed:', err.message ?? err);
      cb?.(err);
    });
  } catch (e) {
    console.warn('[iscale] storage.sync unavailable:', e);
    cb?.(e);
  }
}

export function storageLocalGet(keys: string[], cb: (r: Record<string, unknown>) => void): void {
  try {
    chrome.storage?.local?.get?.(keys, cb);
  } catch {
    cb({});
  }
}

/** Write to local storage (keys + bulky config), surfacing write errors. */
export function storageLocalSet(obj: Record<string, unknown>, cb?: (err: unknown) => void): void {
  try {
    chrome.storage?.local?.set?.(obj, () => {
      const err = chrome.runtime?.lastError ?? null;
      if (err) console.warn('[iscale] storage.local write failed:', err.message ?? err);
      cb?.(err);
    });
  } catch (e) {
    console.warn('[iscale] storage.local unavailable:', e);
    cb?.(e);
  }
}

/** Read `keys` from local storage, transparently migrating any values an older
 *  install left in sync storage. Anything found only in sync is copied into
 *  local and then removed from sync (so secrets stop roaming and bulky config
 *  leaves the 8 KB/item sync area). Returns the merged view (local wins). */
export function storageLocalGetMigrating(keys: string[], cb: (r: Record<string, unknown>) => void): void {
  let local: Record<string, unknown> = {};
  let sync: Record<string, unknown> = {};
  let pending = 2;
  const done = (): void => {
    if (--pending > 0) return;
    const migrated: Record<string, unknown> = {};
    for (const k of keys) {
      if (!(k in local) && k in sync) migrated[k] = sync[k];
    }
    if (Object.keys(migrated).length) {
      storageLocalSet(migrated);
      try {
        chrome.storage?.sync?.remove?.(Object.keys(migrated));
      } catch {
        /* best-effort cleanup */
      }
    }
    cb({ ...sync, ...local, ...migrated });
  };
  // Each read must count down `pending` exactly once, INCLUDING when the storage
  // area itself is missing — a bare `chrome.storage?.local?.get?.()` would
  // short-circuit to undefined without ever invoking the callback, leaving
  // `pending` stuck and the caller's settings load never firing.
  const read = (area: 'local' | 'sync', assign: (r: Record<string, unknown>) => void): void => {
    try {
      const getFn = chrome.storage?.[area]?.get;
      if (typeof getFn !== 'function') {
        done();
        return;
      }
      getFn.call(chrome.storage[area], keys, (r: unknown) => {
        assign((r as Record<string, unknown>) || {});
        done();
      });
    } catch {
      done();
    }
  };
  read('local', (r) => (local = r));
  read('sync', (r) => (sync = r));
}

// ---------------------------------------------------------------------------
// Trademark API key (private deployment: REQUIRE_API_KEY=true). Kept only in
// chrome.storage.local, never synced or exported. When missing, it is fetched
// once from the local iScale helper, which reads it from this machine's key
// file (~/.iscale-listings/trademark-api-key), so nobody types it in.
// ---------------------------------------------------------------------------
export const TM_API_KEY_KEY = 'iscale_tm_api_key';
const HELPER_URL_KEY = 'kw_codex_url';
const DEFAULT_HELPER = 'http://127.0.0.1:18799';

/** The saved registry choice (US only / EU only / US + EU) - defaults to both. */
export async function loadJurisdictions(): Promise<TrademarkJurisdiction[]> {
  const r = await new Promise<Record<string, unknown>>((res) => {
    try {
      if (!chrome.storage?.sync?.get) return res({});
      chrome.storage.sync.get([JURISDICTIONS_KEY], (x) => res(x ?? {}));
    } catch {
      res({});
    }
  });
  return normalizeJurisdictions(r[JURISDICTIONS_KEY]);
}

export async function loadTrademarkApiKey(): Promise<string | null> {
  const r = await new Promise<Record<string, unknown>>((res) => storageLocalGet([TM_API_KEY_KEY, HELPER_URL_KEY], (x) => res(x ?? {})));
  const stored = typeof r[TM_API_KEY_KEY] === 'string' ? (r[TM_API_KEY_KEY] as string).trim() : '';
  if (stored) return stored;
  const helper = typeof r[HELPER_URL_KEY] === 'string' ? (r[HELPER_URL_KEY] as string).trim() : '';
  try {
    const resp = await fetch(`${(helper || DEFAULT_HELPER).replace(/\/+$/, '')}/trademark-key`, {
      headers: { 'X-Iscale-Bridge': '1' },
    });
    if (!resp.ok) return null;
    const key = ((await resp.json()) as { key?: string })?.key?.trim();
    if (!key) return null;
    storageLocalSet({ [TM_API_KEY_KEY]: key });
    return key;
  } catch {
    return null;
  }
}

/** Forget a key the API refused (rotated), so the next call fetches the new one. */
export function forgetTrademarkApiKey(): void {
  try {
    chrome.storage?.local?.remove?.([TM_API_KEY_KEY]);
  } catch {
    /* best effort */
  }
}

