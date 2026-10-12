// Settings UI for the Keywords tab: provider/model inputs, prompt presets,
// field-layout presets, the listing config editor, and banned words. Reads and
// mutates the shared `kw` state; depends only on kw-state (no pipeline/render
// imports → no cycle).

import {
  ALL_FORBIDDEN_WORDS,
  createDefaultPresets,
  DEFAULT_LISTING_CONFIG,
  MODE_INSTRUCTIONS,
} from '@/core/types';
import type { ListingConfig, ListingField } from '@/core/types';
import { escapeHtml as esc, escAttr, storageLocalSet } from './shared';
import { kw, el, kwSaveSettings, KW_FIELD_PRESETS } from './kw-state';
import { buildSharedSettings } from './kw-sync';
import { unbanWord } from '@/core/listing/bannedWords';

// Model menus mirror the website's SettingsDialog (id + short price hint).
const OPENAI_MODELS = [
  ['gpt-4o-mini', 'GPT-4o Mini · cheapest'],
  ['gpt-4o', 'GPT-4o · best vision'],
  ['gpt-4.1-mini', 'GPT-4.1 Mini'],
  ['gpt-4.1', 'GPT-4.1'],
  ['gpt-4.1-nano', 'GPT-4.1 Nano'],
] as const;

// ---------------------------------------------------------------------------
// Field-layout presets — a named, saveable/loadable combo of the listing fields
// (Title, Brand, and any added fields, each with its char limit). The built-in
// "Merch default" is always present; user presets are stored and can be deleted.
// ---------------------------------------------------------------------------

interface FieldPreset {
  name: string;
  fields: ListingField[];
}

const BUILTIN_FIELD_PRESET: FieldPreset = {
  name: 'Merch default',
  fields: structuredClone(DEFAULT_LISTING_CONFIG.fields),
};

let fieldPresets: FieldPreset[] = []; // user-saved only
export let currentFieldPresetName: string | null = null;

/** Restore user field presets from persisted JSON (called by init — it can't
 *  assign the module-private `fieldPresets` binding directly). */
export function loadFieldPresetsFromJson(json: string): void {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) {
      fieldPresets = arr.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.fields));
    }
  } catch {
    /* keep none */
  }
}

/** Built-in + user presets, deduped by name (a user preset overrides built-in). */
function allFieldPresets(): FieldPreset[] {
  const map = new Map<string, FieldPreset>();
  map.set(BUILTIN_FIELD_PRESET.name, BUILTIN_FIELD_PRESET);
  for (const p of fieldPresets) map.set(p.name, p);
  return Array.from(map.values());
}

/** Order-sensitive signature of a field set (name + limit), for matching. */
function fieldsSig(fields: ListingField[]): string {
  return fields.map((f) => `${f.name.toLowerCase().trim()}:${f.maxChars}`).join('|');
}

function editableFields(): ListingField[] {
  return kw.site === 'none' ? kw.config.fields : kw.customFields;
}

function setEditableFields(fields: ListingField[]): void {
  if (kw.site === 'none') {
    kw.config.fields = fields;
  }
  kw.customFields = fields;
}

export function kwSyncKeyInput(): void {
  const input = el('kw-key') as HTMLInputElement;
  const engineRow = document.getElementById('kw-engine-row');
  if (engineRow) engineRow.hidden = kw.provider !== 'codex';
  if (kw.provider === 'codex') {
    input.type = 'text';
    input.placeholder = 'Helper URL — default http://127.0.0.1:18799';
    input.value = kw.codexUrl;
  } else {
    input.type = 'password';
    input.placeholder = 'API key (stored locally)';
    input.value = kw.openaiKey;
  }
}

/** Reflect the current AI prompt rules (config.customInstructions) in the textarea. */
export function kwSyncInstructions(): void {
  const ta = el('kw-instructions') as HTMLTextAreaElement;
  ta.value = kw.config.customInstructions ?? '';
}

// ---------------------------------------------------------------------------
// Prompt presets — renamable slots, each storing its own AI prompt rules. Seeded
// with Balanced / Natural / Aggressive, but the user can rename them and rewrite
// their rules to use the slots for anything. Stored in kw.config (persisted with
// it); the active slot's text mirrors config.customInstructions (what the core
// generateListing reads).
// ---------------------------------------------------------------------------

/** Backfill presets onto a config loaded from the older format (had keywordMode). */
export function ensurePresets(raw: ListingConfig): ListingConfig {
  const anyRaw = raw as unknown as Record<string, unknown>;
  if (Array.isArray(anyRaw['presets']) && (anyRaw['presets'] as unknown[]).length) return raw;
  const legacyMode =
    typeof anyRaw['keywordMode'] === 'string' ? (anyRaw['keywordMode'] as string) : 'balanced';
  const presets = createDefaultPresets();
  const legacy = typeof raw.customInstructions === 'string' ? raw.customInstructions : '';
  if (legacy.trim()) {
    const target = presets.find((p) => p.id === legacyMode) ?? presets[0];
    target.instructions = legacy;
  }
  const activePresetId = presets.some((p) => p.id === legacyMode) ? legacyMode : presets[0].id;
  return {
    ...raw,
    presets,
    activePresetId,
    customInstructions: presets.find((p) => p.id === activePresetId)?.instructions ?? legacy,
  };
}

function activePreset() {
  return kw.config.presets.find((p) => p.id === kw.config.activePresetId) ?? kw.config.presets[0];
}

/** True when the active preset is a built-in default (so it has a reset target). */
function activePresetIsDefault(): boolean {
  const id = activePreset()?.id;
  return !!id && id in MODE_INSTRUCTIONS;
}

function promptPresetInput(): HTMLInputElement | null {
  return document.getElementById('kw-preset') as HTMLInputElement | null;
}

function promptPresetList(): HTMLElement | null {
  return document.getElementById('kw-preset-list') as HTMLElement | null;
}

/** Reflect the active preset: name into the combobox input, EVERY preset as a
 *  listbox option (unfiltered — the popup always lists all presets), list
 *  closed, and the Save (💾) dirty state refreshed. */
export function renderPromptPresets(): void {
  const active = activePreset();
  const input = promptPresetInput();
  if (input) input.value = active?.name ?? '';
  const list = promptPresetList();
  if (list) {
    list.innerHTML = kw.config.presets
      .map(
        (p) =>
          `<li id="kw-preset-opt-${escAttr(p.id)}" role="option" data-preset-id="${escAttr(p.id)}" aria-selected="${p.id === active?.id ? 'true' : 'false'}">${esc(p.name)}</li>`
      )
      .join('');
  }
  closePromptPresetList();
  const reset = document.getElementById('kw-instructions-reset') as HTMLElement | null;
  if (reset) reset.hidden = !activePresetIsDefault();
  refreshPresetDirty();
}

/** Show/hide the preset popup; it always lists every preset, no filtering. */
export function openPromptPresetList(): void {
  const list = promptPresetList();
  if (!list) return;
  list.hidden = false;
  promptPresetInput()?.setAttribute('aria-expanded', 'true');
  document.getElementById('kw-preset-toggle')?.setAttribute('aria-expanded', 'true');
}

export function closePromptPresetList(): void {
  const list = promptPresetList();
  if (list) {
    list.hidden = true;
    for (const o of Array.from(list.querySelectorAll('.kw-active'))) o.classList.remove('kw-active');
  }
  const input = promptPresetInput();
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  document.getElementById('kw-preset-toggle')?.setAttribute('aria-expanded', 'false');
}

export function promptPresetListIsOpen(): boolean {
  const list = promptPresetList();
  return !!list && !list.hidden;
}

/** Escape: put the active preset's name back in the input WITHOUT touching the
 *  working rules, and close the list. */
export function restorePromptPresetName(): void {
  const input = promptPresetInput();
  const active = activePreset();
  if (input && active) input.value = active.name;
  closePromptPresetList();
  refreshPresetDirty();
}

let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

function presetSaveBtn(): HTMLButtonElement | null {
  return document.getElementById('kw-preset-save') as HTMLButtonElement | null;
}

/** Highlight 💾 when there are unsaved changes — the typed name differs from
 *  the active preset's (case-insensitive), or the working rules differ from
 *  what's stored. */
export function refreshPresetDirty(): void {
  const btn = presetSaveBtn();
  if (!btn || btn.classList.contains('kw-flash')) return; // leave the ✓ flash alone
  const active = activePreset();
  const input = promptPresetInput();
  const typed = input ? input.value.trim() : (active?.name ?? '');
  const nameChanged = !!active && typed.toLowerCase() !== active.name.toLowerCase();
  const rulesChanged = !!active && (kw.config.customInstructions ?? '') !== (active.instructions ?? '');
  btn.classList.toggle('kw-dirty', nameChanged || rulesChanged);
}

function flashPresetSaved(): void {
  const btn = presetSaveBtn();
  if (!btn) return;
  btn.classList.remove('kw-dirty');
  btn.classList.add('kw-flash');
  btn.textContent = '✓';
  if (savedFlashTimer) clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => {
    btn.classList.remove('kw-flash');
    btn.textContent = '💾';
    refreshPresetDirty();
  }, 1100);
}

/** Switch to an existing preset (popup pick). Re-picking the already-active
 *  preset re-renders — its name goes back into the input and the list closes —
 *  WITHOUT discarding unsaved working rules. An unknown id is a no-op. */
export function selectPromptPreset(id: string): void {
  const preset = kw.config.presets.find((p) => p.id === id);
  if (!preset) {
    refreshPresetDirty();
    return;
  }
  if (preset.id === kw.config.activePresetId) {
    renderPromptPresets();
    return;
  }
  kw.config.activePresetId = preset.id;
  kw.config.customInstructions = preset.instructions;
  kwSyncInstructions();
  renderPromptPresets();
  kwSaveSettings();
}

/** Editor edits update the *working* prompt rules (what generateListing reads,
 *  persisted) but NOT the stored preset until Save (💾). */
export function updateActiveInstructions(text: string): void {
  kw.config.customInstructions = text;
  kwSaveSettings();
  refreshPresetDirty();
}

/** Save (💾): commit the current working rules under the typed name. A new
 *  (non-matching) name appends a NEW preset and activates it — it never
 *  overwrites the previously active record; a name matching an existing preset
 *  (case-insensitive) updates that record; a BLANK typed name is a no-op (it
 *  must never silently overwrite the active preset). Called with no argument,
 *  it saves the rules into the active preset. */
export function savePromptPreset(newName?: string): void {
  if (newName !== undefined && !newName.trim()) return;
  const rules = kw.config.customInstructions ?? '';
  const name = newName?.trim();
  let target = name
    ? kw.config.presets.find((p) => p.name.toLowerCase() === name.toLowerCase())
    : activePreset();
  if (!target && !name) return;
  if (target) {
    target.instructions = rules;
  } else {
    target = { id: `p${Math.random().toString(36).slice(2, 8)}`, name: name!, instructions: rules };
    kw.config.presets.push(target);
  }
  kw.config.activePresetId = target.id;
  kwSaveSettings();
  renderPromptPresets();
  flashPresetSaved();
}

/** Delete (🗑) the active preset; always keep at least one (no-op on the last). */
export function deletePromptPreset(): void {
  if (kw.config.presets.length <= 1) return;
  kw.config.presets = kw.config.presets.filter((p) => p.id !== kw.config.activePresetId);
  const next = kw.config.presets[0];
  kw.config.activePresetId = next.id;
  kw.config.customInstructions = next.instructions;
  kwSyncInstructions();
  renderPromptPresets();
  kwSaveSettings();
}

/** Reset the active preset's rules to its built-in default (defaults only). */
export function resetActivePreset(): void {
  const active = activePreset();
  if (!active) return;
  const def = (MODE_INSTRUCTIONS as Record<string, string>)[active.id];
  if (def === undefined) return;
  active.instructions = def;
  kw.config.customInstructions = def;
  kwSyncInstructions();
  kwSaveSettings();
  refreshPresetDirty();
}

/** Repopulate the model dropdown for the active provider (hidden for local bridges). */
export function kwSyncModelSelect(): void {
  const wrap = el('kw-model-wrap');
  const sel = el('kw-model') as HTMLSelectElement;
  if (kw.provider === 'codex') {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const current = kw.openaiModel;
  sel.innerHTML = OPENAI_MODELS
    .map(([id, label]) => `<option value="${id}"${id === current ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Listing settings editor: fields + banned words (website ListingConfigPanel)
// ---------------------------------------------------------------------------

export function renderConfigEditor(): void {
  // Product words keyword validation tests with (editable comma list)
  (el('kw-variants') as HTMLInputElement).value = kw.config.productVariants.join(', ');

  // Fields
  const fieldsHost = el('kw-fields');
  const fields = editableFields();
  fieldsHost.innerHTML = fields
    .map(
      (f, i) => `<div class="kw-field-row">
        <input class="kw-input kw-f-name" data-i="${i}" value="${escAttr(f.name)}" placeholder="Field name" />
        <input class="kw-input kw-f-max" data-i="${i}" type="number" min="1" value="${f.maxChars}" />
        <button class="kw-x" data-rmfield="${i}" title="Remove">×</button>
      </div>`
    )
    .join('');
  for (const node of Array.from(fieldsHost.querySelectorAll('.kw-f-name'))) {
    node.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const next = editableFields();
      next[Number(t.dataset['i'])].name = t.value;
      setEditableFields(next);
      kwSaveSettings();
    });
  }
  for (const node of Array.from(fieldsHost.querySelectorAll('.kw-f-max'))) {
    node.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      // Floor at 1 — a 0/NaN maxChars makes the core clamp every field to "".
      const next = editableFields();
      next[Number(t.dataset['i'])].maxChars = Math.max(1, parseInt(t.value) || 1);
      setEditableFields(next);
      kwSaveSettings();
    });
  }
  for (const node of Array.from(fieldsHost.querySelectorAll('[data-rmfield]'))) {
    node.addEventListener('click', (e) => {
      const i = Number((e.target as HTMLElement).dataset['rmfield']);
      setEditableFields(editableFields().filter((_, idx) => idx !== i));
      renderConfigEditor();
      kwSaveSettings();
    });
  }
  renderFieldPresetSelect();

  // Banned words — trademarks you banned from results are listed apart, with the
  // mark they came from, so you can remove one if that mark lapses.
  const banHost = el('kw-forbidden');
  const tmBans = new Map((kw.config.bannedTrademarks ?? []).map((b) => [b.term, b]));
  const pill = (w: string) => {
    const b = tmBans.get(w.trim().toLowerCase());
    const title = b
      ? `Trademark ${b.wordmark}${b.owner ? ` — ${b.owner}` : ''} (${[b.jurisdiction, b.international_class && `class ${b.international_class}`, b.registration_status].filter(Boolean).join(', ')}), banned ${b.addedAt.slice(0, 10)}`
      : '';
    return `<span class="kw-ban${b ? ' kw-ban-tm' : ''}"${title ? ` title="${escAttr(title)}"` : ''}>${b ? '™ ' : ''}${esc(w)}<button class="kw-x" data-rmban="${escAttr(w)}">×</button></span>`;
  };
  const tmWords = kw.config.forbiddenWords.filter((w) => tmBans.has(w.trim().toLowerCase()));
  const plainWords = kw.config.forbiddenWords.filter((w) => !tmBans.has(w.trim().toLowerCase()));
  banHost.innerHTML =
    (tmWords.length
      ? `<div class="kw-sub" style="width:100%">Banned trademarks (${tmWords.length}) — hover for the mark:</div>${tmWords.map(pill).join('')}<div class="kw-sub" style="width:100%">Other banned words:</div>`
      : '') + plainWords.map(pill).join('');
  for (const node of Array.from(banHost.querySelectorAll('[data-rmban]'))) {
    node.addEventListener('click', (e) => {
      const w = (e.target as HTMLElement).dataset['rmban'];
      if (w) kw.config = unbanWord(kw.config, w);
      renderConfigEditor();
      kwSaveSettings();
    });
  }
}

/**
 * Keep the custom field preset editor available in settings. Manual mode edits
 * the active listing fields; marketplace modes edit the saved custom layout
 * without changing the marketplace's fixed generation/fill fields.
 */
export function renderSiteFieldsUi(): void {
  const section = document.getElementById('kw-fields-section');
  if (section) section.hidden = false;
  renderConfigEditor();
}

export function addField(): void {
  const fields = editableFields();
  const f: ListingField = { id: `field-${fields.length + 1}-${Math.random().toString(36).slice(2, 6)}`, name: '', maxChars: 256 };
  setEditableFields([...fields, f]);
  currentFieldPresetName = null; // diverged from any preset
  renderConfigEditor();
  kwSaveSettings();
}

// --- Field-preset operations ----------------------------------------------

function persistFieldPresets(): void {
  storageLocalSet({ [KW_FIELD_PRESETS]: JSON.stringify(fieldPresets) });
}

/** Repopulate the preset dropdown + toggle the Delete button for built-ins. */
function renderFieldPresetSelect(): void {
  const sel = el('kw-field-preset') as HTMLSelectElement;
  const presets = allFieldPresets();
  const sig = fieldsSig(editableFields());
  // Reflect the active preset by name, or fall back to a deep match, else Custom.
  const active =
    currentFieldPresetName && presets.some((p) => p.name === currentFieldPresetName)
      ? currentFieldPresetName
      : (presets.find((p) => fieldsSig(p.fields) === sig)?.name ?? '');
  currentFieldPresetName = active || null;
  const modified = active && fieldsSig(presets.find((p) => p.name === active)!.fields) !== sig;
  sel.innerHTML =
    `<option value="">${active ? 'Custom (unsaved)' : 'Custom layout'}</option>` +
    presets
      .map((p) => `<option value="${escAttr(p.name)}"${p.name === active ? ' selected' : ''}>${esc(p.name)}${p.name === active && modified ? ' (modified)' : ''}</option>`)
      .join('');
  if (!active) sel.value = '';
  // Delete only enabled for a user preset (not the built-in, not "Custom").
  const isUser = !!active && fieldPresets.some((p) => p.name === active);
  (el('kw-fp-del') as HTMLButtonElement).disabled = !isUser;
}

export function applyFieldPreset(name: string): void {
  const preset = allFieldPresets().find((p) => p.name === name);
  if (!preset) return;
  setEditableFields(structuredClone(preset.fields));
  currentFieldPresetName = name;
  renderConfigEditor();
  kwSaveSettings();
}

export function saveFieldPreset(rawName: string): void {
  const name = rawName.trim();
  if (!name) return;
  const fields = structuredClone(editableFields());
  const existing = fieldPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0) fieldPresets[existing] = { name, fields };
  else fieldPresets = [...fieldPresets, { name, fields }];
  currentFieldPresetName = name;
  persistFieldPresets();
  renderConfigEditor();
}

export function deleteFieldPreset(): void {
  if (!currentFieldPresetName) return;
  fieldPresets = fieldPresets.filter((p) => p.name !== currentFieldPresetName);
  currentFieldPresetName = null;
  persistFieldPresets();
  renderConfigEditor();
}

export function addBannedWords(raw: string): void {
  const words = raw
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && !kw.config.forbiddenWords.includes(w));
  if (words.length) {
    kw.config.forbiddenWords = [...kw.config.forbiddenWords, ...words];
    renderConfigEditor();
    kwSaveSettings();
  }
}

/** Reset banned words to the core default list. */
export function resetBannedWords(): void {
  // Keep the trademarks you banned; reset only the other words to the defaults.
  const tmTerms = (kw.config.bannedTrademarks ?? []).map((b) => b.term);
  kw.config.forbiddenWords = [...new Set([...ALL_FORBIDDEN_WORDS, ...tmTerms])];
  renderConfigEditor();
  kwSaveSettings();
}

/** Download the current listing settings (presets, prompt rules, fields, keyword
 *  + trademark config) as a JSON file. The CLI loads the same file via --config,
 *  so a listing generated on the command line uses the exact UI settings. Only
 *  `kw.config` is exported — never API keys (those live under separate storage
 *  keys and stay out of the file). */
export function exportSettings(): void {
  // Same document the CLI reads/writes (`iscale settings import|export`):
  // listing config + non-secret prefs. API keys are never included.
  const payload = {
    ...buildSharedSettings(),
    version: chrome.runtime?.getManifest?.().version ?? null,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'iscale-listings-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
