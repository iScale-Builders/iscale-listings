// Entry point for the extension's "Keywords" tab: wires the DOM controls to the
// state / settings / pipeline modules and restores persisted settings. The heavy
// lifting lives in:
//   • kw-state.ts    — the shared `kw` state + foundational helpers
//   • kw-settings.ts — provider/model inputs, prompt + field presets, config editor
//   • kw-pipeline.ts — the vision→keywords→listing→trademark pipeline + results UI
//
// Those modules call the EXACT same core functions the iscale-listings website
// uses (imported from `../iscale-listings/src` via the `@/` esbuild alias). The
// logic stays identical on both surfaces — don't fork the core here.

import { escapeHtml as esc, storageLocalGetMigrating } from './shared';
import {
  kw,
  el,
  kwApplyRunMode,
  kwSaveSettings,
  kwFlushSettings,
  kwSetRunMode,
  kwUpdateGenerateEnabled,
  KW_PROVIDER_KEY,
  KW_OPENAI_KEY,
  KW_CODEX_URL,
  KW_OPENCLAW_URL,
  KW_OPENAI_MODEL,
  KW_TM_ENABLED,
  KW_TM_API_BASE,
  KW_CONFIG_KEY,
  KW_FIELD_PRESETS,
  KW_RUN_MODE,
  KW_VALIDATE_ENABLED,
  KW_SITE,
  KW_CUSTOM_FIELDS,
  KW_LOCAL_ENGINE,
  KW_LOCAL_MODEL,
  KW_SETTINGS_UPDATED_AT,
  KW_AUTO_SHARE,
  LOCAL_ENGINES,
  applySiteFields,
  kwPersistAdopted,
  onSettingsSaved,
} from './kw-state';
import type { KwSite, LocalEngine } from './kw-state';
import {
  applySharedSettings,
  importSettingsDoc,
  isNewer,
  pullSharedSettings,
  pushSharedSettings,
  renderSyncStatus,
} from './kw-sync';
import {
  ensurePresets,
  loadFieldPresetsFromJson,
  kwSyncKeyInput,
  kwSyncInstructions,
  kwSyncModelSelect,
  renderPromptPresets,
  renderConfigEditor,
  renderSiteFieldsUi,
  selectPromptPreset,
  openPromptPresetList,
  closePromptPresetList,
  promptPresetListIsOpen,
  restorePromptPresetName,
  refreshPresetDirty,
  updateActiveInstructions,
  savePromptPreset,
  deletePromptPreset,
  resetActivePreset,
  addField,
  applyFieldPreset,
  saveFieldPreset,
  deleteFieldPreset,
  addBannedWords,
  resetBannedWords,
  exportSettings,
  currentFieldPresetName,
} from './kw-settings';
import { setTrademarkApiBase } from '@/core/listing/trademarkCheck';
import {
  kwGrabFromPage,
  kwSetImage,
  kwGrabNote,
  clearKwRun,
  connectSite,
  regenerate,
  runPipeline,
  runAnalyze,
  restoreLastRun,
} from './kw-pipeline';

export function initKeywordsTab(): void {
  const providerSel = el('kw-provider') as HTMLSelectElement;
  const keyInput = el('kw-key') as HTMLInputElement;
  const modelSel = el('kw-model') as HTMLSelectElement;
  const tmToggle = el('kw-tm-enabled') as HTMLInputElement;
  const tmApiBaseInput = el('kw-tm-api-base') as HTMLInputElement;
  const fileInput = el('kw-file') as HTMLInputElement;
  const localModelInput = el('kw-local-model') as HTMLInputElement;

  storageLocalGetMigrating(
    [
      KW_PROVIDER_KEY, KW_OPENAI_KEY, KW_CODEX_URL, KW_OPENCLAW_URL,
      KW_OPENAI_MODEL, KW_TM_ENABLED, KW_TM_API_BASE, KW_CONFIG_KEY,
      KW_FIELD_PRESETS, KW_RUN_MODE, KW_VALIDATE_ENABLED, KW_SITE, KW_CUSTOM_FIELDS,
      KW_LOCAL_ENGINE, KW_LOCAL_MODEL, KW_SETTINGS_UPDATED_AT, KW_AUTO_SHARE,
    ],
    (r) => {
      if (LOCAL_ENGINES.includes(r?.[KW_LOCAL_ENGINE] as LocalEngine)) kw.localEngine = r[KW_LOCAL_ENGINE] as LocalEngine;
      if (typeof r?.[KW_LOCAL_MODEL] === 'string') kw.localModel = r[KW_LOCAL_MODEL] as string;
      if (typeof r?.[KW_SETTINGS_UPDATED_AT] === 'string') kw.settingsUpdatedAt = r[KW_SETTINGS_UPDATED_AT] as string;
      if (typeof r?.[KW_AUTO_SHARE] === 'boolean') kw.autoShare = r[KW_AUTO_SHARE] as boolean;
      const p = r?.[KW_PROVIDER_KEY];
      if (p === 'openclaw' || p === 'codex') kw.provider = 'codex';
      else if (p === 'openai') kw.provider = p;
      if (typeof r?.[KW_OPENAI_KEY] === 'string') kw.openaiKey = r[KW_OPENAI_KEY] as string;
      if (typeof r?.[KW_CODEX_URL] === 'string') kw.codexUrl = r[KW_CODEX_URL] as string;
      else if (typeof r?.[KW_OPENCLAW_URL] === 'string') kw.codexUrl = r[KW_OPENCLAW_URL] as string;
      if (typeof r?.[KW_OPENAI_MODEL] === 'string') kw.openaiModel = r[KW_OPENAI_MODEL] as string;
      if (typeof r?.[KW_TM_ENABLED] === 'boolean') kw.trademarkEnabled = r[KW_TM_ENABLED] as boolean;
      if (typeof r?.[KW_TM_API_BASE] === 'string') kw.tmApiBase = r[KW_TM_API_BASE] as string;
      if (typeof r?.[KW_VALIDATE_ENABLED] === 'boolean') kw.validateEnabled = r[KW_VALIDATE_ENABLED] as boolean;
      if (r?.[KW_RUN_MODE] === 'auto' || r?.[KW_RUN_MODE] === 'manual') kw.runMode = r[KW_RUN_MODE];
      if (r?.[KW_SITE] === 'none' || r?.[KW_SITE] === 'amazon-merch' || r?.[KW_SITE] === 'etsy') {
        kw.site = r[KW_SITE] as KwSite;
      }
      if (typeof r?.[KW_CONFIG_KEY] === 'string') {
        try {
          const c = JSON.parse(r[KW_CONFIG_KEY] as string);
          if (c?.fields && Array.isArray(c.fields)) kw.config = ensurePresets(c);
        } catch {
          /* keep default */
        }
      }
      if (typeof r?.[KW_CUSTOM_FIELDS] === 'string') {
        try {
          const cf = JSON.parse(r[KW_CUSTOM_FIELDS] as string);
          if (Array.isArray(cf) && cf.length) kw.customFields = cf;
        } catch {
          /* keep default custom fields */
        }
      }
      // Fields are governed by the selected site, not the saved config.fields:
      // a marketplace uses its fixed layout, manual uses kw.customFields.
      applySiteFields();
      if (typeof r?.[KW_FIELD_PRESETS] === 'string') {
        loadFieldPresetsFromJson(r[KW_FIELD_PRESETS] as string);
      }
      refreshSettingsUi();
      void connectSite(); // if a site is already selected, connect + auto-read on open
      void syncWithHelper();
    }
  );

  // Adopt the helper's settings when they are newer (e.g. edited from the CLI),
  // otherwise publish ours so the CLI sees what the extension shows.
  async function syncWithHelper(): Promise<void> {
    if (!kw.autoShare) return renderSyncStatus('off');
    const remote = await pullSharedSettings();
    if (remote === 'offline') return renderSyncStatus('offline');
    if (remote && isNewer(remote, kw.settingsUpdatedAt)) {
      applySharedSettings(remote);
      kw.config = ensurePresets(kw.config); // same repair as a Chrome-stored config
      applySiteFields();
      kwPersistAdopted();
      refreshSettingsUi();
      return renderSyncStatus('synced');
    }
    renderSyncStatus(await pushSharedSettings());
  }
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  onSettingsSaved(() => {
    if (!kw.autoShare) return renderSyncStatus('off');
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushSharedSettings().then(renderSyncStatus), 300);
  });

  function refreshSettingsUi(): void {
    providerSel.value = kw.provider;
    (el('kw-auto-share') as HTMLInputElement).checked = kw.autoShare;
    localModelInput.value = kw.localModel;
    tmToggle.checked = kw.trademarkEnabled;
    tmApiBaseInput.value = kw.tmApiBase;
    if (kw.tmApiBase.trim()) setTrademarkApiBase(kw.tmApiBase);
    const valToggle = document.getElementById('kw-validate-enabled') as HTMLInputElement | null;
    if (valToggle) valToggle.checked = kw.validateEnabled;
    const singleTmToggle = document.getElementById('kw-allow-single-tm') as HTMLInputElement | null;
    if (singleTmToggle) singleTmToggle.checked = !!kw.config.allowSingleWordTrademarks;
    const maxFillToggle = document.getElementById('kw-max-fill') as HTMLInputElement | null;
    if (maxFillToggle) maxFillToggle.checked = !!kw.config.maxFill;
    kwApplyRunMode();
    kwSyncKeyInput();
    kwSyncModelSelect();
    kwSyncInstructions();
    renderPromptPresets();
    renderConfigEditor();
    renderSiteFieldsUi(); // show the manual field editor only when editable
    kwUpdateGenerateEnabled();
    (el('kw-site') as HTMLSelectElement).value = kw.site;
    // The Trademark tab's category buttons show the same classes.
    document.dispatchEvent(new CustomEvent('kw-classes-changed'));
  }

  el('kw-auto-share').addEventListener('change', () => {
    kw.autoShare = (el('kw-auto-share') as HTMLInputElement).checked;
    kwSaveSettings();
    void syncWithHelper();
  });

  // Feedback shown right under the AI settings (where the sync status lives).
  const settingsNote = (text: string): void => {
    const node = document.getElementById('kw-sync-status');
    if (node) node.textContent = text;
  };

  // Import: the extension's or the CLI's exported settings file.
  const importFile = el('kw-import-file') as HTMLInputElement;
  el('kw-import-settings').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    try {
      importSettingsDoc(JSON.parse(await file.text()));
      kw.config = ensurePresets(kw.config);
      applySiteFields();
      kwSaveSettings();
      refreshSettingsUi();
      settingsNote(`✓ Imported settings from ${file.name}.`);
    } catch (e) {
      settingsNote(`⚠ Couldn't import ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  localModelInput.addEventListener('change', () => {
    kw.localModel = localModelInput.value.trim();
    kwSaveSettings();
  });

  el('kw-site').addEventListener('change', () => {
    const v = (el('kw-site') as HTMLSelectElement).value;
    kw.site = v === 'amazon-merch' ? 'amazon-merch' : v === 'etsy' ? 'etsy' : 'none';
    applySiteFields(); // swap to that site's fixed layout, or restore the manual one
    renderSiteFieldsUi(); // show/hide the manual editor
    kwSaveSettings();
    void connectSite();
  });
  // Re-connect (and auto-read) when the panel regains focus — e.g. after the
  // user uploads their art on the Merch page and clicks back to the panel.
  window.addEventListener('focus', () => {
    if (kw.site !== 'none') void connectSite();
    void syncWithHelper(); // pick up settings changed from the CLI meanwhile
  });
  // Settings writes are debounced (see kwSaveSettings); flush any pending write
  // before the panel goes away so a just-typed setting can't be lost.
  window.addEventListener('pagehide', () => kwFlushSettings());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') kwFlushSettings();
  });

  providerSel.addEventListener('change', () => {
    const v = providerSel.value;
    kw.provider = v === 'openai' ? 'openai' : 'codex';
    kwSyncKeyInput();
    kwSyncModelSelect();
    kwUpdateGenerateEnabled();
    kwSaveSettings();
  });

  modelSel.addEventListener('change', () => {
    kw.openaiModel = modelSel.value;
    kwSaveSettings();
  });

  // Prompt presets: an always-editable combobox. Typing a name NEVER switches
  // presets — 💾 saves the working rules under the typed name (a new name
  // appends a new preset; the same name updates that record; blank is a no-op).
  // ▾ opens the full, unfiltered list; picking an option is the only way to
  // switch. 🗑 deletes the active preset.
  const promptInput = el('kw-preset') as HTMLInputElement;
  const promptToggle = el('kw-preset-toggle') as HTMLButtonElement;
  const promptList = el('kw-preset-list') as HTMLElement;
  let presetNavIdx = -1; // keyboard-highlighted option, -1 = none
  const presetOptions = () =>
    Array.from(promptList.querySelectorAll('[data-preset-id]')) as HTMLElement[];
  const clearPresetNav = () => {
    presetNavIdx = -1;
    for (const o of presetOptions()) o.classList.remove('kw-active');
    promptInput.removeAttribute('aria-activedescendant');
  };
  const highlightPresetOption = (idx: number) => {
    const opts = presetOptions();
    presetNavIdx = idx < 0 || !opts.length ? -1 : ((idx % opts.length) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('kw-active', i === presetNavIdx));
    if (presetNavIdx >= 0) {
      promptInput.setAttribute('aria-activedescendant', opts[presetNavIdx].id);
      opts[presetNavIdx].scrollIntoView({ block: 'nearest' });
    } else {
      promptInput.removeAttribute('aria-activedescendant');
    }
  };
  const commitPromptPreset = () => savePromptPreset(promptInput.value.trim());
  promptInput.addEventListener('input', () => {
    clearPresetNav();
    refreshPresetDirty();
  });
  // No 'change'/'blur' handler on the input — typing a name (even an exact
  // existing one) must never load that preset's rules.
  promptInput.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      // A closed list means any remembered highlight is stale — start fresh.
      if (!promptPresetListIsOpen()) presetNavIdx = -1;
      openPromptPresetList();
      if (key === 'ArrowDown') highlightPresetOption(presetNavIdx + 1);
      else highlightPresetOption(presetNavIdx < 0 ? presetOptions().length - 1 : presetNavIdx - 1);
    } else if (key === 'Enter') {
      e.preventDefault();
      if (presetNavIdx >= 0 && promptPresetListIsOpen()) {
        const id = presetOptions()[presetNavIdx]?.dataset['presetId'];
        presetNavIdx = -1;
        if (id) selectPromptPreset(id);
      } else {
        commitPromptPreset();
      }
    } else if (key === 'Escape') {
      e.preventDefault();
      presetNavIdx = -1;
      restorePromptPresetName(); // active name back; working rules untouched
    }
  });
  promptToggle.addEventListener('click', () => {
    if (promptPresetListIsOpen()) closePromptPresetList();
    else openPromptPresetList();
    clearPresetNav();
    promptInput.focus();
  });
  // mousedown preventDefault keeps focus on the input so the option's 'click'
  // still fires (blur would otherwise hide the list first). Selection happens
  // on 'click' so touch/AT activation works and non-primary buttons can't
  // switch presets.
  promptList.addEventListener('mousedown', (e) => {
    if ((e as MouseEvent).button === 0) e.preventDefault();
  });
  promptList.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest('[data-preset-id]') as HTMLElement | null;
    if (!opt) return;
    const id = opt.dataset['presetId'];
    clearPresetNav();
    if (id) selectPromptPreset(id);
  });
  // Clicks outside close the list WITHOUT resetting the typed name.
  document.addEventListener('click', (e) => {
    if (!promptPresetListIsOpen()) return;
    const t = e.target as Node;
    if (!promptList.contains(t) && !promptInput.contains(t) && !promptToggle.contains(t)) {
      presetNavIdx = -1;
      closePromptPresetList();
    }
  });
  el('kw-preset-save').addEventListener('click', () => commitPromptPreset());
  el('kw-preset-del').addEventListener('click', () => deletePromptPreset());

  const instructions = el('kw-instructions') as HTMLTextAreaElement;
  instructions.addEventListener('input', () => {
    // Edits update the working rules; Save 💾 commits them to the preset.
    updateActiveInstructions(instructions.value);
  });
  el('kw-instructions-reset').addEventListener('click', () => resetActivePreset());

  const validateToggle = el('kw-validate-enabled') as HTMLInputElement;
  validateToggle.addEventListener('change', () => {
    kw.validateEnabled = validateToggle.checked;
    kwSaveSettings();
  });
  const allowSingleTm = el('kw-allow-single-tm') as HTMLInputElement;
  allowSingleTm.addEventListener('change', () => {
    kw.config.allowSingleWordTrademarks = allowSingleTm.checked;
    kwSaveSettings();
  });
  const maxFill = el('kw-max-fill') as HTMLInputElement;
  maxFill.addEventListener('change', () => {
    kw.config.maxFill = maxFill.checked;
    kwSaveSettings();
  });

  tmToggle.addEventListener('change', () => {
    kw.trademarkEnabled = tmToggle.checked;
    kwSaveSettings();
  });

  tmApiBaseInput.addEventListener('input', () => {
    kw.tmApiBase = tmApiBaseInput.value;
    setTrademarkApiBase(kw.tmApiBase); // '' falls back to the localhost default
    kwSaveSettings();
  });

  keyInput.addEventListener('input', () => {
    if (kw.provider === 'codex') kw.codexUrl = keyInput.value;
    else kw.openaiKey = keyInput.value;
    kwUpdateGenerateEnabled();
    kwSaveSettings();
  });

  // Listing-settings editor: the product words keyword validation tests with
  const variantsInput = el('kw-variants') as HTMLInputElement;
  variantsInput.addEventListener('input', () => {
    const list = variantsInput.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    kw.config.productVariants = list.length ? list : ['shirt'];
    kwSaveSettings();
  });

  el('kw-add-field').addEventListener('click', () => addField());

  // Field-layout presets
  const presetSel = el('kw-field-preset') as HTMLSelectElement;
  presetSel.addEventListener('change', () => {
    if (presetSel.value) applyFieldPreset(presetSel.value);
  });
  const fpName = el('kw-fp-name') as HTMLInputElement;
  // Naming a preset: double-click the dropdown (or click 💾) to swap it for an
  // inline text field, type a name, then Enter / 💾 to save. Escape cancels.
  const enterFpEdit = (prefill: string) => {
    presetSel.hidden = true;
    fpName.hidden = false;
    fpName.value = prefill;
    fpName.focus();
    fpName.select();
  };
  const exitFpEdit = () => {
    fpName.hidden = true;
    presetSel.hidden = false;
  };
  const commitFp = () => {
    const name = fpName.value.trim();
    if (name) saveFieldPreset(name); // re-renders the dropdown with the new preset
    exitFpEdit();
  };
  presetSel.addEventListener('dblclick', () => enterFpEdit(''));
  el('kw-fp-save').addEventListener('click', () => {
    if (fpName.hidden) enterFpEdit(currentFieldPresetName ?? '');
    else commitFp();
  });
  fpName.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter') {
      e.preventDefault();
      commitFp();
    } else if (key === 'Escape') {
      e.preventDefault();
      exitFpEdit();
    }
  });
  el('kw-fp-del').addEventListener('click', () => deleteFieldPreset());

  el('kw-export-settings').addEventListener('click', () => exportSettings());
  el('kw-reset-ban').addEventListener('click', () => resetBannedWords());
  const banInput = el('kw-ban-input') as HTMLInputElement;
  el('kw-add-ban').addEventListener('click', () => {
    addBannedWords(banInput.value);
    banInput.value = '';
  });
  banInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      addBannedWords(banInput.value);
      banInput.value = '';
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      kwGrabNote('');
      kwSetImage(String(reader.result));
    };
    reader.readAsDataURL(file);
  });

  el('kw-grab').addEventListener('click', () => void kwGrabFromPage());
  el('kw-generate').addEventListener('click', () => {
    if (kw.validated.length) {
      void regenerate();
      return;
    }
    void (kw.runMode === 'manual' ? runAnalyze() : runPipeline());
  });
  el('kw-clear').addEventListener('click', () => clearKwRun());
  for (const seg of Array.from(document.querySelectorAll('[data-runmode]'))) {
    seg.addEventListener('click', () =>
      kwSetRunMode((seg as HTMLElement).dataset['runmode'] === 'manual' ? 'manual' : 'auto')
    );
  }

  // The last generated listing comes back after a panel close/reload.
  restoreLastRun();

  // Populate immediately from defaults so the UI is never blank; the storage
  // callback above re-syncs once persisted settings load.
  kwSyncKeyInput();
  kwSyncModelSelect();
  kwSyncInstructions();
  renderPromptPresets();
  renderConfigEditor();
  kwApplyRunMode();
  kwUpdateGenerateEnabled();
}
