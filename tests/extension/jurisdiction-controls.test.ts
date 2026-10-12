import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { JURISDICTIONS_KEY, JURISDICTION_OPTIONS, normalizeJurisdictions } from '../../extension/shared';

function harness() {
  const source = readFileSync(new URL('../../extension/sidepanel.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function sameJurisdictions(');
  const end = source.indexOf('// Loaded from storage, adopted from the CLI, or imported:');
  const hosts = Object.fromEntries(['juris', 'kw-juris'].map(id => [id, {
    children: [] as any[],
    set innerHTML(_: string) { this.children = []; },
    appendChild(button: any) { this.children.push(button); },
  }]));
  const document = {
    getElementById: (id: string) => hosts[id],
    createElement: () => ({ dataset: {} as Record<string, string>, attributes: {} as Record<string, string>, click: () => {}, setAttribute(k: string, v: string) { this.attributes[k] = v; }, addEventListener(_: string, click: () => void) { this.click = click; } }),
  };
  const storageSet = vi.fn(); const save = vi.fn(); const page = vi.fn();
  let changed: (changes: any, area: string) => void;
  const chrome = { storage: { onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } } };
  const kw = { config: { trademarkClasses: ['025'], trademarkJurisdictions: ['EUIPO'] } };
  const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
  const api = new Function('document', 'chrome', 'kw', 'storageSet', 'kwSaveSettings', 'sendToPage', 'normalizeJurisdictions', 'JURISDICTION_OPTIONS', 'JURISDICTIONS_KEY', `let selectedJurisdictions=['US','EUIPO']; const renderCats=()=>{}; const renderResults=()=>{}; const pageConfig=()=>({jurisdictions:[...selectedJurisdictions],classes:kw.config.trademarkClasses}); ${code}; return {setSelectedJurisdictions,renderJurisdictions};`)(document, chrome, kw, storageSet, save, page, normalizeJurisdictions, JURISDICTION_OPTIONS, JURISDICTIONS_KEY);
  const selected = (id: string) => hosts[id].children.filter(b => b.attributes['aria-pressed'] === 'true').map(b => b.dataset.juris);
  return { api, hosts, selected, kw, storageSet, save, page, external: (value: string[]) => changed({ [JURISDICTIONS_KEY]: { newValue: value } }, 'sync') };
}

describe('shared jurisdiction controls', () => {
  it('renders the existing EU-only preference in both tabs without resetting storage', () => {
    const h = harness(); h.kw.config.trademarkJurisdictions = ['US', 'EUIPO']; h.api.setSelectedJurisdictions(['EUIPO'], false);
    expect(h.selected('juris')).toEqual(['eu']); expect(h.selected('kw-juris')).toEqual(['eu']);
    expect(h.storageSet).not.toHaveBeenCalled();
  });
  it.each(['juris', 'kw-juris'])('selection from %s repaints both tabs and scopes page/core checks together', id => {
    const h = harness(); h.kw.config.trademarkJurisdictions = ['US', 'EUIPO']; h.api.setSelectedJurisdictions(['EUIPO'], false);
    h.hosts[id].children.find(b => b.dataset.juris === 'both').click();
    expect(h.selected('juris')).toEqual(['both']); expect(h.selected('kw-juris')).toEqual(['both']);
    expect(h.kw.config.trademarkJurisdictions).toEqual(['US', 'EUIPO']);
    expect(h.page).toHaveBeenLastCalledWith({ jurisdictions: ['US', 'EUIPO'], classes: ['025'] });
    expect(h.storageSet).toHaveBeenLastCalledWith({ [JURISDICTIONS_KEY]: ['US', 'EUIPO'] });
  });
  it('external saved selection repaints both tabs, updates core config, and does not echo a sync write', () => {
    const h = harness(); h.api.renderJurisdictions(); h.external(['US']);
    expect(h.selected('juris')).toEqual(['us']); expect(h.selected('kw-juris')).toEqual(['us']);
    expect(h.kw.config.trademarkJurisdictions).toEqual(['US']); expect(h.save).toHaveBeenCalledOnce();
    expect(h.storageSet).not.toHaveBeenCalled(); expect(h.page).toHaveBeenLastCalledWith({ jurisdictions: ['US'], classes: ['025'] });
  });
});
