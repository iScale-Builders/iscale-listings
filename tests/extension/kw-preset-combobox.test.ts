// Prompt-preset combobox behavior: typing a name never switches presets, 💾
// saves the working rules under the typed name (new name → separate record,
// matching name → that record, blank → no-op), the popup always lists every
// preset, and Escape restores the active name without touching the rules.
// Runs in the node environment with a minimal DOM stub — kw-settings only
// touches document.getElementById and element value/hidden/innerHTML/attrs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { kw } from '@/extension/kw-state';
import {
  renderPromptPresets,
  savePromptPreset,
  deletePromptPreset,
  resetActivePreset,
  selectPromptPreset,
  updateActiveInstructions,
  refreshPresetDirty,
  restorePromptPresetName,
  openPromptPresetList,
  closePromptPresetList,
  promptPresetListIsOpen,
} from '@/extension/kw-settings';
import { DEFAULT_LISTING_CONFIG, MODE_INSTRUCTIONS } from '@/core/types';

class FakeElement {
  value = '';
  hidden = true;
  innerHTML = '';
  textContent = '';
  dataset: Record<string, string> = {};
  classList = {
    contains: (_: string) => false,
    toggle: () => {},
    add: () => {},
    remove: () => {},
  };
  private attrs = new Map<string, string>();
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  querySelectorAll(): unknown[] {
    return [];
  }
  contains(): boolean {
    return false;
  }
}

let els: Record<string, FakeElement>;

function installDom(): void {
  els = {};
  for (const id of [
    'kw-preset',
    'kw-preset-list',
    'kw-preset-toggle',
    'kw-preset-save',
    'kw-instructions',
    'kw-instructions-reset',
    'kw-save-status',
  ]) {
    els[id] = new FakeElement();
  }
  vi.stubGlobal('document', {
    getElementById: (id: string) => els[id] ?? null,
    createTextNode: (s: string) => ({ textContent: s }),
    // Minimal stand-in for shared.ts escapeHtml (text node → escaped innerHTML).
    createElement: () => {
      const d = {
        _text: '',
        appendChild(n: { textContent?: string }) {
          d._text = n.textContent ?? '';
        },
        get innerHTML() {
          return d._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      };
      return d;
    },
  });
}

const input = () => els['kw-preset'];
const list = () => els['kw-preset-list'];

describe('prompt-preset combobox (type a name and save)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installDom();
    kw.config = structuredClone(DEFAULT_LISTING_CONFIG);
    renderPromptPresets();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('typing a NEW name and saving appends a separate preset, keeping the original unchanged', () => {
    const original = kw.config.presets.find((p) => p.id === 'balanced')!;
    const originalInstructions = original.instructions;
    updateActiveInstructions('edited working rules');
    input().value = 'My new preset';
    savePromptPreset(input().value.trim());

    const created = kw.config.presets.find((p) => p.name === 'My new preset')!;
    expect(created).toBeTruthy();
    expect(created.id).not.toBe('balanced');
    expect(created.instructions).toBe('edited working rules');
    expect(kw.config.activePresetId).toBe(created.id);
    // The original preset's id, name and rules are untouched.
    expect(original.id).toBe('balanced');
    expect(original.name).toBe('Balanced');
    expect(original.instructions).toBe(originalInstructions);
  });

  it('a second new name preserves BOTH the first new preset and the original', () => {
    savePromptPreset('First custom');
    updateActiveInstructions('second rules');
    savePromptPreset('Second custom');

    const names = kw.config.presets.map((p) => p.name);
    expect(names).toContain('Balanced');
    expect(names).toContain('First custom');
    expect(names).toContain('Second custom');
    expect(kw.config.presets.find((p) => p.name === 'First custom')).toBeTruthy();
    expect(kw.config.activePresetId).toBe(kw.config.presets.find((p) => p.name === 'Second custom')!.id);
  });

  it('saving with a name that matches an existing preset (case-insensitive) updates only that record', () => {
    updateActiveInstructions('rules for natural');
    savePromptPreset('NATURAL'); // matches 'Natural' ignoring case
    const natural = kw.config.presets.find((p) => p.id === 'natural')!;
    expect(natural.instructions).toBe('rules for natural');
    expect(kw.config.activePresetId).toBe('natural');
    expect(kw.config.presets).toHaveLength(3); // nothing appended
    expect(kw.config.presets.find((p) => p.id === 'balanced')!.instructions).toBe(MODE_INSTRUCTIONS.balanced);
  });

  it('a blank name is a no-op — never silently overwrites the active preset', () => {
    updateActiveInstructions('unsaved typed rules');
    savePromptPreset('   ');
    const balanced = kw.config.presets.find((p) => p.id === 'balanced')!;
    expect(balanced.instructions).toBe(MODE_INSTRUCTIONS.balanced);
    expect(kw.config.presets).toHaveLength(3);
    expect(kw.config.activePresetId).toBe('balanced');
    // Working rules still live in customInstructions (not lost), just unsaved.
    expect(kw.config.customInstructions).toBe('unsaved typed rules');
  });

  it('typing an existing preset name does NOT load that preset\'s rules', () => {
    updateActiveInstructions('my working rules');
    input().value = 'Natural'; // typed only — no selection
    refreshPresetDirty();
    expect(kw.config.activePresetId).toBe('balanced');
    expect(kw.config.customInstructions).toBe('my working rules');
    expect(els['kw-instructions'].value).not.toBe(MODE_INSTRUCTIONS.natural);
  });

  it('the popup lists EVERY preset even after typing a partial/new name (unfiltered)', () => {
    input().value = 'zzz-no-match';
    openPromptPresetList(); // opens without touching the typed name
    expect(promptPresetListIsOpen()).toBe(true);
    // Opening the list never rewrites the typed name.
    expect(input().value).toBe('zzz-no-match');
    for (const name of ['Balanced', 'Natural', 'Aggressive']) {
      expect(list().innerHTML).toContain(name);
    }
    expect(list().innerHTML.match(/data-preset-id=/g)).toHaveLength(3);
  });

  it('render shows the active preset name in the input and closes the list', () => {
    openPromptPresetList();
    expect(promptPresetListIsOpen()).toBe(true);
    renderPromptPresets();
    expect(input().value).toBe('Balanced');
    expect(promptPresetListIsOpen()).toBe(false);
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('re-picking the ALREADY-ACTIVE option restores its name, closes the list, keeps unsaved rules', () => {
    updateActiveInstructions('unsaved working rules');
    input().value = 'Typed New Name';
    openPromptPresetList();
    selectPromptPreset('balanced'); // already the active preset
    expect(input().value).toBe('Balanced');
    expect(promptPresetListIsOpen()).toBe(false);
    expect(kw.config.customInstructions).toBe('unsaved working rules');
    expect(kw.config.activePresetId).toBe('balanced');
  });

  it('an unknown preset id is a no-op (typed name and rules preserved)', () => {
    updateActiveInstructions('unsaved working rules');
    input().value = 'Typed New Name';
    selectPromptPreset('does-not-exist');
    expect(input().value).toBe('Typed New Name');
    expect(kw.config.customInstructions).toBe('unsaved working rules');
    expect(kw.config.activePresetId).toBe('balanced');
  });

  it('picking an option (selectPromptPreset) switches presets and loads ITS rules', () => {
    updateActiveInstructions('unsaved edits');
    selectPromptPreset('natural');
    expect(kw.config.activePresetId).toBe('natural');
    expect(kw.config.customInstructions).toBe(MODE_INSTRUCTIONS.natural);
    expect(input().value).toBe('Natural');
  });

  it('Escape restores the active preset name without changing the working rules', () => {
    updateActiveInstructions('keep these rules');
    input().value = 'typed but unsaved name';
    restorePromptPresetName();
    expect(input().value).toBe('Balanced');
    expect(kw.config.customInstructions).toBe('keep these rules');
    expect(kw.config.activePresetId).toBe('balanced');
    expect(promptPresetListIsOpen()).toBe(false);
  });

  it('delete removes the active preset and reset restores a default\'s rules', () => {
    selectPromptPreset('natural');
    updateActiveInstructions('changed');
    resetActivePreset();
    expect(kw.config.customInstructions).toBe(MODE_INSTRUCTIONS.natural);
    deletePromptPreset();
    expect(kw.config.presets.find((p) => p.id === 'natural')).toBeUndefined();
    expect(kw.config.presets.length).toBe(2);
    // Deleting down to one preset is a no-op.
    deletePromptPreset();
    deletePromptPreset();
    expect(kw.config.presets.length).toBe(1);
  });

  it('save with no argument still commits rules into the active preset', () => {
    updateActiveInstructions('committed');
    savePromptPreset();
    expect(kw.config.presets.find((p) => p.id === 'balanced')!.instructions).toBe('committed');
  });
});
