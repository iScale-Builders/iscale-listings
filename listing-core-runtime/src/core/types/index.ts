// ============================================================
// STEP 1: IMAGE INPUT
// ============================================================
export interface ImageInput {
  file: File;
  preview: string; // base64 for display
  filename: string;
}

// ============================================================
// STEP 2: AI ANALYSIS
// ============================================================
export interface ImageAnalysis {
  visualElements: string[]; // ["grumpy cat", "coffee cup", "steam"]
  detectedText: string[]; // ["Monday Mood"]
  mood: string; // "sarcastic"
  style: string; // "cartoon"
  colors: string[]; // ["orange", "brown", "white"]
  scene?: string; // free-text description of the artwork, when a sidecar has one
  themes?: string[]; // niches / audience / occasion, when a sidecar has them
  rawResponse: string; // full AI response for debugging
}

// ============================================================
// STEP 3: CANDIDATE KEYWORDS
// ============================================================
export type KeywordSource =
  | 'visual'
  | 'text'
  | 'who'
  | 'what'
  | 'why'
  | 'when'
  | 'where'
  | 'lsi'
  | 'manual'; // user-added

export interface CandidateKeyword {
  id: string; // unique ID
  word: string; // "coffee lover"
  source: KeywordSource;
  isPhrase: boolean; // true if contains space
}

// ============================================================
// STEP 4: VALIDATION
// ============================================================
export interface ValidationCheck {
  query: string; // "coffee lover shirt"
  productVariant: string; // "shirt" | "tshirt" | "t-shirt"
  found: boolean;
  position: number | null; // 1-10, null if not found
  suggestions: string[]; // all suggestions returned (for debugging)
  errored?: boolean; // the autosuggest fetch failed (rate-limit/network) — NOT a real "not found"
}

export interface ValidatedKeyword {
  id: string;
  word: string; // "coffee lover"
  source: KeywordSource;
  isPhrase: boolean;

  // For phrases, also track individual word validations
  subWords: string[]; // ["coffee", "lover"]

  // All validation attempts
  validations: ValidationCheck[];

  // Summary
  certified: boolean; // at least one validation found
  // True when we could NOT actually check this keyword — every autosuggest call
  // for it errored (rate-limit/network). `certified: false` then means "unknown",
  // not "verified absent", so the UI must not present it as a clean miss.
  unverified?: boolean;
  bestPosition: number | null; // lowest position found across all checks
  bestVariant: string | null; // which product variant had best position

  // User selection state
  selected: boolean;
}

// ============================================================
// LISTING CONFIGURATION (dynamic fields)
// ============================================================
export interface ListingField {
  id: string;
  name: string;
  maxChars: number;
}

// A named, user-editable prompt preset. The three defaults (Balanced / Natural /
// Aggressive) are just seed values — users can rename them and rewrite their
// instructions to use the slots for anything.
export interface KeywordPreset {
  id: string;
  name: string;
  instructions: string;
}

export interface ListingConfig {
  fields: ListingField[];
  productType: 'shirt';
  productVariants: string[];
  customInstructions: string; // live prompt text — mirrors the active preset's instructions
  forbiddenWords: string[];
  maxKeywords: number;
  trademarkClasses: string[];
  /** Registries to screen: ['US'], ['EUIPO'], or both (default when unset). */
  trademarkJurisdictions?: ('US' | 'EUIPO')[];
  presets: KeywordPreset[];
  activePresetId: string;
  allowSingleWordTrademarks?: boolean; // ordinary single words informational; famous brands still block
  maxFill?: boolean; // AI append-only pass that pads each field to near its char limit
  /** Trademarks the user chose to ban from a result. Each `term` is also in
   *  forbiddenWords (that list is what's enforced); this keeps the mark details. */
  bannedTrademarks?: BannedTrademark[];
}

export interface BannedTrademark {
  term: string; // what is banned (lowercase), e.g. "casual friday"
  wordmark: string; // the registered/pending mark, e.g. "CASUAL FRIDAY"
  owner?: string;
  international_class?: string;
  jurisdiction?: string;
  registration_status?: string;
  serial_number?: string;
  addedAt: string;
}

// ============================================================
// TRADEMARK CLASSES (Nice Classification)
// ============================================================
export interface TrademarkClassInfo {
  code: string;
  label: string;
  color: string; // Tailwind bg class for active pill
  colorLight: string; // Tailwind classes for inactive/outline pill
}

export const TRADEMARK_CLASSES: TrademarkClassInfo[] = [
  {
    code: '009',
    label: 'Phone Cases',
    color: 'bg-blue-500',
    colorLight: 'border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-400',
  },
  {
    code: '016',
    label: 'Paper & Stickers',
    color: 'bg-yellow-500',
    colorLight: 'border-yellow-300 text-yellow-600 dark:border-yellow-700 dark:text-yellow-400',
  },
  {
    code: '018',
    label: 'Bags & Leather',
    color: 'bg-purple-500',
    colorLight: 'border-purple-300 text-purple-600 dark:border-purple-700 dark:text-purple-400',
  },
  {
    code: '020',
    label: 'Home Decor',
    color: 'bg-orange-500',
    colorLight: 'border-orange-300 text-orange-600 dark:border-orange-700 dark:text-orange-400',
  },
  {
    code: '021',
    label: 'Drinkware',
    color: 'bg-cyan-500',
    colorLight: 'border-cyan-300 text-cyan-600 dark:border-cyan-700 dark:text-cyan-400',
  },
  {
    code: '024',
    label: 'Textiles',
    color: 'bg-pink-500',
    colorLight: 'border-pink-300 text-pink-600 dark:border-pink-700 dark:text-pink-400',
  },
  {
    code: '025',
    label: 'Apparel',
    color: 'bg-emerald-500',
    colorLight: 'border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400',
  },
];

// ============================================================
// FORBIDDEN WORDS — single source of truth
// ============================================================
export const FORBIDDEN_PRODUCT_WORDS = [
  'shirt',
  't-shirt',
  'tshirt',
  'tee',
  'hoodie',
  'sweatshirt',
  'tank',
  'apparel',
  'clothing',
  'garment',
];

export const FORBIDDEN_MATERIAL_WORDS = [
  'gold',
  'silver',
  'neon',
  'glitter',
  'metallic',
  'shiny',
  'holographic',
  'foil',
  'chrome',
  'sparkle',
  'glow',
  'luminous',
  'reflective',
];

export const FORBIDDEN_GIFT_WORDS = ['gift', 'present', 'gifting'];

/** All forbidden words combined as a flat list. */
export const ALL_FORBIDDEN_WORDS = [
  ...FORBIDDEN_PRODUCT_WORDS,
  ...FORBIDDEN_MATERIAL_WORDS,
  ...FORBIDDEN_GIFT_WORDS,
];

export type DefaultPresetId = 'balanced' | 'natural' | 'aggressive';

export const MODE_INSTRUCTIONS: Record<DefaultPresetId, string> = {
  balanced: `Each field should read naturally while including keywords.
Don't keyword stuff - make it readable.
LONGTAIL PRIORITY: Keep multi-word phrases together (e.g. "coffee lover", "cat mom"). Phrases are more valuable than individual words.
The listing describes the DESIGN only, not the product.`,
  natural: `Write polished, complete sentences that read beautifully. Readability and flow come FIRST.
Include keywords only where they fit naturally. Do NOT force keywords in.
Every field must be a proper, grammatically correct sentence or phrase.
It is OK to use fewer keywords if the listing reads better.
Keep multi-word phrases together when used.
The listing describes the DESIGN only, not the product.`,
  aggressive: `Pack as many keywords as possible into each field.
Every keyword should appear at least once across all fields.
Readability is secondary to keyword density.
Keep multi-word phrases together.
The listing describes the DESIGN only, not the product.`,
};

// Seed presets. Deep-cloned into each config so renames/edits never mutate these.
export const DEFAULT_PRESET_META: { id: DefaultPresetId; name: string }[] = [
  { id: 'balanced', name: 'Balanced' },
  { id: 'natural', name: 'Natural' },
  { id: 'aggressive', name: 'Aggressive' },
];

export function createDefaultPresets(): KeywordPreset[] {
  return DEFAULT_PRESET_META.map(({ id, name }) => ({
    id,
    name,
    instructions: MODE_INSTRUCTIONS[id],
  }));
}

/** How many top-ranked keywords are handed to the AI to write with. 10 (the
 *  old default, never user-editable) left the AI too few words to fill the
 *  fields without repeating itself (Jose 2026-10-04). */
export const DEFAULT_MAX_KEYWORDS = 30;
const LEGACY_DEFAULT_MAX_KEYWORDS = 10;

/** The keyword count to use for a stored config (an old stored 10 means the default). */
export function maxKeywordsOf(config: Pick<ListingConfig, 'maxKeywords'>): number {
  const n = config.maxKeywords;
  return !n || n === LEGACY_DEFAULT_MAX_KEYWORDS ? DEFAULT_MAX_KEYWORDS : n;
}

export const DEFAULT_LISTING_CONFIG: ListingConfig = {
  fields: [
    { id: 'title', name: 'Title', maxChars: 60 },
    { id: 'brand', name: 'Brand', maxChars: 50 },
    { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
    { id: 'bullet-2', name: 'Bullet Point Description', maxChars: 256 },
  ],
  productType: 'shirt',
  productVariants: ['shirt', 'tshirt', 't-shirt'],
  customInstructions: MODE_INSTRUCTIONS.balanced,
  forbiddenWords: [...ALL_FORBIDDEN_WORDS],
  maxKeywords: DEFAULT_MAX_KEYWORDS,
  trademarkClasses: ['025'],
  presets: createDefaultPresets(),
  activePresetId: 'balanced',
  allowSingleWordTrademarks: true,
  maxFill: false,
};

// ============================================================
// GENERATED OUTPUT
// ============================================================
export interface GeneratedField {
  fieldId: string;
  fieldName: string;
  content: string;
  charCount: number;
  maxChars: number;
  keywordsUsed: string[];
  certifiedCount: number;
  fillerCount: number;
}

export interface GeneratedListing {
  fields: GeneratedField[];
  metadata: {
    generatedAt: string; // ISO timestamp
    configUsed: ListingConfig;
    totalCertifiedUsed: number;
    totalFillerUsed: number;
    validationStats: {
      totalCandidates: number;
      totalChecks: number;
      certifiedCount: number;
      notFoundCount: number;
    };
  };
}

// ============================================================
// APP STATE
// ============================================================
export interface AppState {
  currentStep: 1 | 2 | 3 | 4 | 5;
  autoRun: boolean;
  image: ImageInput | null;
  analysis: ImageAnalysis | null;
  analysisLoading: boolean;
  analysisError: string | null;
  candidates: CandidateKeyword[];
  validated: ValidatedKeyword[];
  validationLoading: boolean;
  validationProgress: number; // 0-100
  validationError: string | null;
  config: ListingConfig;
  listing: GeneratedListing | null;
  listingLoading: boolean;
  settings: UserSettings;
}

export type AIProvider = 'openai' | 'codex';

export interface UserSettings {
  aiProvider: AIProvider;
  openaiApiKey: string;
  openaiModel: string;
  codexUrl: string; // base URL of the local iScale helper (your AI subscription)
  defaultConfig: ListingConfig;
  concurrency: number; // parallel autosuggest calls
}

// ============================================================
// FETCHER TYPES (for dependency injection)
// ============================================================
export type AutosuggestFetcher = (prefix: string) => Promise<string[]>;
