// Type-checked by vitest at run time only: it imports extension modules that use the
// extension build's `@/core` alias (excluded from the root tsconfig for that reason).
import { describe, it, expect, beforeEach } from 'vitest';
import { kw } from '@/extension/kw-state';
import { buildSharedSettings, importSettingsDoc, isNewer } from '@/extension/kw-sync';
import { normalizeSettings } from '@/cli/lib/settings-store.mjs';
import { DEFAULT_LISTING_CONFIG } from '@/core/types';

const config = { ...structuredClone(DEFAULT_LISTING_CONFIG), customInstructions: 'FROM-CLI' };

describe('extension settings Export / Import', () => {
  beforeEach(() => {
    kw.config = structuredClone(DEFAULT_LISTING_CONFIG);
    kw.provider = 'codex';
    kw.localModel = '';
    kw.settingsUpdatedAt = '';
  });

  it('imports the CLI export (`iscale settings export`) — config and prefs', () => {
    const cliExport = normalizeSettings({ config, prefs: { localModel: 'gpt-5.5', provider: 'openai', tmApiBase: 'https://tm.example' } });
    importSettingsDoc(JSON.parse(JSON.stringify(cliExport)));
    expect(kw.config.customInstructions).toBe('FROM-CLI');
    expect(kw.localModel).toBe('gpt-5.5');
    expect(kw.provider).toBe('openai');
    expect(kw.tmApiBase).toBe('https://tm.example');
    expect(Date.parse(kw.settingsUpdatedAt)).toBeGreaterThan(0);
  });

  it('imports an older extension export (config only) and a bare config', () => {
    importSettingsDoc({ type: 'iscale-listings-settings', version: '0.6.12', config });
    expect(kw.config.customInstructions).toBe('FROM-CLI');
    kw.config = structuredClone(DEFAULT_LISTING_CONFIG);
    importSettingsDoc(config);
    expect(kw.config.customInstructions).toBe('FROM-CLI');
  });

  it('rejects files that are not settings, leaving the current settings alone', () => {
    const before = kw.config;
    expect(() => importSettingsDoc({ listings: [] })).toThrow(/Not an iScale Listings settings file/);
    expect(kw.config).toBe(before);
  });

  it('exports what the CLI accepts, and never an API key', () => {
    kw.openaiKey = 'sk-should-never-leave-chrome';
    const exported = buildSharedSettings();
    expect(() => normalizeSettings(exported)).not.toThrow();
    expect(JSON.stringify(exported)).not.toContain('sk-should-never-leave-chrome');
  });

  it('only adopts strictly newer remote settings', () => {
    const doc = { ...buildSharedSettings(), updatedAt: '2026-10-01T10:00:00.000Z' };
    expect(isNewer(doc, '2026-10-01T09:00:00.000Z')).toBe(true);
    expect(isNewer(doc, '2026-10-01T10:00:00.000Z')).toBe(false);
    expect(isNewer(doc, '')).toBe(true);
  });
});
