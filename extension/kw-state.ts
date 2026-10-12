// Shared mutable state + foundational helpers for the Keywords tab. The single
// `kw` object is the source of truth; the settings, pipeline, and render modules
// all import and mutate it. Nothing here imports those modules (keeps the graph
// acyclic).

import { DEFAULT_LISTING_CONFIG } from '@/core/types';
import type {
  AIProvider,
  GeneratedListing,
  ImageAnalysis,
  ListingConfig,
  ListingField,
  ValidatedKeyword,
} from '@/core/types';
import type { AIConfig } from '@/lib/ai-provider';
import type { TrademarkReport } from '@/core/listing/trademarkCheck';
import { storageLocalSet } from './shared';

export const KW_PROVIDER_KEY = 'kw_provider';
export const KW_OPENAI_KEY = 'kw_openai_key';
export const KW_CODEX_URL = 'kw_codex_url';
/** @deprecated leftover OpenClaw storage key; read once then stored as KW_CODEX_URL */
export const KW_OPENCLAW_URL = 'kw_openclaw_url';
export const KW_OPENAI_MODEL = 'kw_openai_model';
export const KW_TM_ENABLED = 'kw_tm_enabled';
// Shared with background.ts (its page-scan path reads storage directly — it
// can't import the panel's state module).
export const KW_TM_API_BASE = 'kw_tm_api_base';
export const KW_CONFIG_KEY = 'kw_config';
export const KW_FIELD_PRESETS = 'kw_field_presets';
export const KW_RUN_MODE = 'kw_run_mode';
export const KW_VALIDATE_ENABLED = 'kw_validate_enabled';
export const KW_SITE = 'kw_site';
export const KW_CUSTOM_FIELDS = 'kw_custom_fields';
export const KW_LOCAL_ENGINE = 'kw_local_engine';
export const KW_LOCAL_MODEL = 'kw_local_model';
/** When the shared (non-secret) settings last changed — decides helper vs Chrome. */
export const KW_SETTINGS_UPDATED_AT = 'kw_settings_updated_at';

export type LocalEngine = 'codex';
export const LOCAL_ENGINES: readonly LocalEngine[] = ['codex'];
/** Sync settings with the helper automatically (off = Export/Import only). */
export const KW_AUTO_SHARE = 'kw_auto_share';

/** Selected site. Drives the listing fields: a marketplace site uses that
 *  marketplace's FIXED field layout (no custom editing); 'none' = manual, where
 *  the user edits their own fields in the main panel. Amazon Merch additionally
 *  auto-connects to read the design + fill the page; Etsy is fields-only. */
export type KwSite = 'none' | 'amazon-merch' | 'etsy';

/** Fixed, non-editable field layouts per marketplace. 'none' (manual) has no
 *  fixed layout — it uses the user's editable `kw.customFields` instead. */
export const SITE_FIELDS: Record<KwSite, ListingField[] | null> = {
  none: null,
  'amazon-merch': [
    { id: 'title', name: 'Title', maxChars: 60 },
    { id: 'brand', name: 'Brand', maxChars: 50 },
    { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
    { id: 'bullet-2', name: 'Bullet Point Description', maxChars: 256 },
  ],
  etsy: [
    { id: 'title', name: 'Title', maxChars: 140 },
    { id: 'tags', name: 'Tags (13 max · ≤20 chars each, comma-separated)', maxChars: 260 },
    { id: 'description', name: 'Description', maxChars: 2000 },
  ],
};

/** The user's editable manual field layout (used only when site === 'none'). */
export const DEFAULT_CUSTOM_FIELDS: ListingField[] = [
  { id: 'title', name: 'Title', maxChars: 60 },
  { id: 'brand', name: 'Brand', maxChars: 50 },
  { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
  { id: 'bullet-2', name: 'Bullet Point Description', maxChars: 256 },
];

export interface KwState {
  provider: AIProvider;
  openaiKey: string;
  codexUrl: string;
  localEngine: LocalEngine;
  localModel: string;
  settingsUpdatedAt: string;
  autoShare: boolean;
  openaiModel: string;
  trademarkEnabled: boolean;
  // Base URL of the trademark API deployment ('' = the core's localhost default).
  tmApiBase: string;
  validateEnabled: boolean;
  runMode: 'auto' | 'manual';
  site: KwSite;
  config: ListingConfig;
  // The manual ('none' site) field layout, preserved across site switches so
  // hopping to Amazon/Etsy and back doesn't lose the user's custom fields.
  customFields: ListingField[];
  imageBase64: string | null;
  // Current run
  analysis: ImageAnalysis | null;
  validated: ValidatedKeyword[];
  listing: GeneratedListing | null;
  trademark: TrademarkReport | null;
  trademarkError: string | null;
  busy: boolean;
}

export const kw: KwState = {
  provider: 'codex',
  openaiKey: '',
  codexUrl: '',
  localEngine: 'codex',
  localModel: '',
  settingsUpdatedAt: '',
  autoShare: true,
  openaiModel: 'gpt-4o-mini',
  trademarkEnabled: true,
  tmApiBase: '',
  validateEnabled: true,
  runMode: 'auto',
  site: 'none',
  config: structuredClone(DEFAULT_LISTING_CONFIG),
  customFields: structuredClone(DEFAULT_CUSTOM_FIELDS),
  imageBase64: null,
  analysis: null,
  validated: [],
  listing: null,
  trademark: null,
  trademarkError: null,
  busy: false,
};

export const el = (id: string) => document.getElementById(id)!;

export function kwActiveKey(): string {
  return kw.openaiKey;
}
export function kwHasCreds(): boolean {
  return kw.provider === 'codex' ? true : !!kwActiveKey().trim();
}

/** Build the AIConfig for the chosen provider, including the selected model. */
export function kwAiConfig(): AIConfig {
  if (kw.provider === 'codex') {
    return {
      provider: 'codex',
      apiKey: '',
      codexUrl: kw.codexUrl.trim() || undefined,
      localEngine: kw.localEngine,
      localModel: kw.localModel.trim() || undefined,
    };
  }
  return {
    provider: 'openai',
    apiKey: kwActiveKey().trim(),
    openaiModel: kw.openaiModel,
  };
}

// Settings persist to chrome.storage.local: it holds the API keys (never upload
// secrets to the Google account) and the bulky config/presets (no 8 KB/item sync
// cap). Writes are DEBOUNCED — the AI-rules textarea, field-name and char-limit
// inputs all call kwSaveSettings() on every keystroke, which would blow past
// Chrome's write-rate limits and start failing silently. We coalesce to one
// write after a short idle, and flush on panel hide so nothing is lost.
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function buildSettingsPayload(): Record<string, unknown> {
  // In manual mode the live config.fields IS the user's custom layout — keep the
  // preserved copy in sync so it survives a hop to a marketplace site and back.
  if (kw.site === 'none') kw.customFields = kw.config.fields;
  return {
    [KW_PROVIDER_KEY]: kw.provider,
    [KW_OPENAI_KEY]: kw.openaiKey,
    [KW_CODEX_URL]: kw.codexUrl,
    [KW_OPENAI_MODEL]: kw.openaiModel,
    [KW_TM_ENABLED]: kw.trademarkEnabled,
    [KW_TM_API_BASE]: kw.tmApiBase,
    [KW_VALIDATE_ENABLED]: kw.validateEnabled,
    [KW_SITE]: kw.site,
    [KW_CUSTOM_FIELDS]: JSON.stringify(kw.customFields),
    [KW_CONFIG_KEY]: JSON.stringify(kw.config),
    [KW_LOCAL_ENGINE]: kw.localEngine,
    [KW_LOCAL_MODEL]: kw.localModel,
    [KW_SETTINGS_UPDATED_AT]: kw.settingsUpdatedAt,
    [KW_AUTO_SHARE]: kw.autoShare,
  };
}

// Called after every settings write so the shared-settings sync (kw-sync) can
// push to the local helper. Registered by keywords.ts — keeps this module
// free of imports from the modules that depend on it.
let afterSave: (() => void) | null = null;
export function onSettingsSaved(cb: () => void): void {
  afterSave = cb;
}

/** Show/clear the "couldn't save" surfaces, so a failed write is visible instead
 *  of silently lost. Two surfaces: the notice inside the settings panel AND a red
 *  badge on the always-visible gear button — the panel is hidden by default, so
 *  the notice alone would go unseen until the user happens to open settings.
 *  (DOM-only; no module imports here, to keep kw-state dependency-free.) */
function surfaceSaveError(err: unknown): void {
  const node = document.getElementById('kw-save-status');
  if (node) {
    if (err) {
      node.textContent = "⚠ Couldn't save settings — they may not persist.";
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  }
  const gear = document.getElementById('kw-settings-btn');
  if (gear) {
    gear.classList.toggle('gear-error', !!err);
    gear.title = err
      ? "Couldn't save settings — they may not persist. Click for details."
      : 'Keyword settings (provider & API key)';
  }
}

/** Persist to Chrome WITHOUT bumping settingsUpdatedAt or re-notifying — used
 *  when adopting newer settings from the helper (they are already shared). */
export function kwPersistAdopted(): void {
  storageLocalSet(buildSettingsPayload(), surfaceSaveError);
}

function flushSaveSettings(): void {
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  kw.settingsUpdatedAt = new Date().toISOString();
  storageLocalSet(buildSettingsPayload(), surfaceSaveError);
  afterSave?.();
}

export function kwSaveSettings(): void {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaveSettings, SAVE_DEBOUNCE_MS);
}

/** Force any pending debounced write to land now (call on panel hide/unload so a
 *  setting edited in the last few hundred ms isn't lost when the panel closes). */
export function kwFlushSettings(): void {
  if (saveTimer != null) flushSaveSettings();
}

/** Point kw.config.fields at the layout for the current site: a marketplace's
 *  FIXED layout, or the user's editable custom layout when manual ('none'). */
export function applySiteFields(): void {
  const fixed = SITE_FIELDS[kw.site];
  kw.config.fields = structuredClone(fixed ?? kw.customFields);
}

export function kwUpdateGenerateEnabled(): void {
  const btn = el('kw-generate') as HTMLButtonElement;
  const hasGeneratedKeywords = kw.validated.length > 0;
  const disabled = (!kw.imageBase64 && !hasGeneratedKeywords) || kw.busy;
  btn.disabled = disabled;
  btn.textContent = kw.listing ? 'Add Keywords' : hasGeneratedKeywords ? 'Regenerate' : 'Submit';
  if (kw.busy) btn.title = '';
  else if (kw.listing) btn.title = 'Append selected keywords to the current listing';
  else if (hasGeneratedKeywords && kwHasCreds()) btn.title = 'Generate listing from the selected keywords';
  else if (hasGeneratedKeywords || kw.imageBase64) btn.title = 'Add an API key in settings, or choose Codex (subscription)';
  else btn.title = 'Load a design first';
  // "Clear & start over" appears once there's a loaded design or any run output
  // to discard, and hides mid-run so it can't wipe state under a live pipeline.
  const clearBtn = document.getElementById('kw-clear') as HTMLButtonElement | null;
  if (clearBtn) {
    const hasRun = !!(kw.imageBase64 || kw.analysis || kw.validated.length || kw.listing);
    clearBtn.hidden = !hasRun || kw.busy;
  }
}

/** Auto/Manual toggle: highlight the active segment. The single Submit button
 *  dispatches by kw.runMode (auto = full pipeline, manual = analyze + pick). */
export function kwApplyRunMode(): void {
  for (const seg of Array.from(document.querySelectorAll('[data-runmode]'))) {
    seg.classList.toggle('kw-seg-on', (seg as HTMLElement).dataset['runmode'] === kw.runMode);
  }
}

export function kwSetRunMode(mode: 'auto' | 'manual'): void {
  kw.runMode = mode;
  kwApplyRunMode();
  storageLocalSet({ [KW_RUN_MODE]: mode });
}
