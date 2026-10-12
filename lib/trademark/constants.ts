import { MAX_TRADEMARK_WORDS } from '../../listing-core-runtime/src/core/listing/constants';

export const ALLOWED_CLASSES = ['009', '016', '018', '020', '021', '024', '025'] as const;
export type AllowedClass = (typeof ALLOWED_CLASSES)[number];

export const JURISDICTIONS = ['US', 'EUIPO', 'FR', 'DE', 'IT', 'ES', 'UK', 'JP'] as const;
export type JurisdictionCode = (typeof JURISDICTIONS)[number];

export const DEFAULT_JURISDICTIONS: readonly JurisdictionCode[] = ['US'];

export const JURISDICTION_LABELS: Record<JurisdictionCode, string> = {
  US: 'United States',
  EUIPO: 'European Union',
  FR: 'France',
  DE: 'Germany',
  IT: 'Italy',
  ES: 'Spain',
  UK: 'United Kingdom',
  JP: 'Japan',
};

export const FRESHNESS_HOURS_BY_JURISDICTION: Record<JurisdictionCode, number> = {
  US: 48,
  // Weekly refresh, but EUIPO's source date is Monday 00:00 UTC and GitHub runs the
  // Monday job hours late (observed 09:30–16:30 UTC). 7 days exactly made EU data
  // "stale" every Monday until the job finished; 8 days absorbs that, and a missed
  // week still shows as stale one day later.
  EUIPO: 192,
  FR: 240,
  DE: 240,
  IT: 240,
  ES: 72,
  UK: 168,
  JP: 240,
};

/** Color assigned to each international class for UI consistency */
export const CLASS_COLORS: Record<string, string> = {
  '009': '#3b82f6', // blue — Phone Cases
  '016': '#eab308', // yellow — Paper & Stickers
  '018': '#a855f7', // purple — Bags & Leather
  '020': '#f97316', // orange — Home Decor
  '021': '#06b6d4', // cyan — Drinkware
  '024': '#ec4899', // pink — Textiles
  '025': '#22c55e', // green — Apparel
};

export const CLASS_LABELS: Record<string, string> = {
  '009': 'PHONE CASES',
  '016': 'PAPER & STICKERS',
  '018': 'BAGS & LEATHER',
  '020': 'HOME DECOR',
  '021': 'DRINKWARE',
  '024': 'TEXTILES',
  '025': 'APPAREL',
};

export const MAX_TEXT_LENGTH = 2000;
export const MIN_TEXT_LENGTH = 2;
/** Maximum candidates accepted for one API request before failing loud. */
export const MAX_CANDIDATES = 2000;
/** Keep individual exact-index RPC calls bounded even when a request generates more. */
export const MAX_RPC_CANDIDATES = 500;
export const MAX_RESULTS = 50;
export const MAX_BATCH_SIZE = 20;
export const MAX_NGRAM_WORDS = MAX_TRADEMARK_WORDS;

/** Per-tier batch size limits */
export const BATCH_LIMITS = {
  anonymous: 0,
  free: 5,
  premium: 20,
} as const;

/** Per-tier rate limits (requests per minute) */
export const RATE_LIMITS = {
  anonymous: 120,
  free: 240,
  premium: 480,
} as const;
