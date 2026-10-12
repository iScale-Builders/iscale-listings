import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importListings, loadStore, parseCsv, recordsFromFile, saveStore, scanListings, scanCompletionExitCode } from '@/cli/lib/monitor.mjs';

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-mon-'));
  env = { ISCALE_HOME: home } as unknown as NodeJS.ProcessEnv;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ETSY_CSV =
  'TITLE,DESCRIPTION,PRICE,TAGS,SKU\r\n' +
  '"Cat Dad Funny Gift","Line one\nline ""two""",19.99,"cat dad,funny cat,gift",SKU-1\r\n' +
  'Retro Sunset Surf,Waves,21.00,"surf,retro",SKU-2\r\n' +
  ',no title row,1,,SKU-3\r\n';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes and newlines inside fields', () => {
    const rows = parseCsv(ETSY_CSV);
    expect(rows[1][1]).toBe('Line one\nline "two"');
    expect(rows[1][3]).toBe('cat dad,funny cat,gift');
    expect(rows).toHaveLength(4);
  });
});

describe('degraded coverage', () => {
  it('still reports a conflict found in the regions that WERE searched', async () => {
    const { checkText } = await import('@/cli/lib/trademark.mjs');
    const realFetch = globalThis.fetch;
    // US answered, EUIPO skipped (the D-01 situation): the core refuses to call it complete…
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          matches: [{ wordmark: 'NIKE', matched_text: 'nike', serial_number: '1', international_class: '025', jurisdiction: 'US', status: 'LIVE', registration_status: 'registered', confidence: 'low', owner: 'Nike, Inc.' }],
          total_matches: 1, truncated: false, data_stale: true, jurisdictions_checked: ['US'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;
    try {
      const r = await checkText({ text: 'Nike Lover Gift', classes: ['025'], apiBase: 'http://127.0.0.1:9' });
      // …but the NIKE hit is real, so the answer is RISK, flagged as incomplete — never CLEAR.
      expect(r.status).toBe('risk');
      expect(r.incomplete).toBe(true);
      expect(r.actionable[0].wordmark).toBe('NIKE');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('store monitoring', () => {
  it('imports an Etsy export, keyed by SKU, and re-import updates instead of duplicating', () => {
    const file = path.join(home, 'etsy.csv');
    fs.writeFileSync(file, ETSY_CSV);
    const store = loadStore(env);
    expect(importListings(store, recordsFromFile(file), { source: 'etsy.csv' })).toMatchObject({ added: 2, skipped: 1 });
    expect(store.listings[0]).toMatchObject({ id: 'SKU-1', title: 'Cat Dad Funny Gift', tags: ['cat dad', 'funny cat', 'gift'] });
    expect(importListings(store, recordsFromFile(file))).toMatchObject({ added: 0, updated: 2, total: 2 });
    saveStore(store, env);
    expect(loadStore(env).listings).toHaveLength(2);
  });

  it('alerts once per new match, screens tags as separate terms, and never treats unverified as clear', async () => {
    const store = loadStore(env);
    importListings(store, [{ title: 'Cat Dad Funny Gift', tags: ['cat dad'] }, { title: 'Retro Sunset', tags: [] }]);
    const seen: Array<{ text: string; terms: string[] }> = [];
    let registered = false;
    const check = async ({ text, terms }: { text: string; terms: string[] }) => {
      seen.push({ text, terms });
      if (text.startsWith('Retro')) return { status: 'unverified', reason: 'EUIPO not checked', actionable: [] };
      return registered
        ? { status: 'risk', actionable: [{ wordmark: 'CAT DAD', serial_number: '999', jurisdiction: 'US', international_class: '025', registration_status: 'registered' }] }
        : { status: 'clear', actionable: [] };
    };
    const first = await scanListings(store, { check: check as never });
    expect(first).toMatchObject({ clear: 1, unverified: 1, newAlerts: [] });
    expect(seen[0]).toEqual({ text: 'Cat Dad Funny Gift', terms: ['cat dad'] });

    registered = true; // a mark gets registered after the listing already existed
    const second = await scanListings(store, { check: check as never });
    expect(second.newAlerts).toHaveLength(1);
    expect(second.newAlerts[0]).toMatchObject({ wordmark: 'CAT DAD', title: 'Cat Dad Funny Gift' });

    const third = await scanListings(store, { check: check as never });
    expect(third.newAlerts).toHaveLength(0);
    expect(store.alerts).toHaveLength(1);
    expect(store.listings[1].lastScan.status).toBe('unverified');
  });

  it('paces the scan and retries a rate-limited listing instead of recording UNVERIFIED (audit 2026-10-07)', async () => {
    const store = { listings: [{ id: 'a', title: 'Cat Dad', tags: [] }, { id: 'b', title: 'Dog Mom', tags: [] }], alerts: [] as unknown[] };
    const waits: number[] = [];
    let calls = 0;
    const check = async () => {
      calls += 1;
      if (calls === 1) return { status: 'unverified', reason: 'Trademark API error: {"error":{"code":"RATE_LIMITED"}}', actionable: [] };
      return { status: 'clear', actionable: [] };
    };
    const s = await scanListings(store as never, { check: check as never, perMinute: 60, rateLimitPauseMs: 5000, wait: async (ms: number) => { waits.push(ms); } });
    expect(s).toMatchObject({ scanned: 2, clear: 2, unverified: 0 });
    expect(calls).toBe(3);
    expect(waits[0]).toBe(5000); // the rate-limit pause
    expect(waits.slice(1).every((ms) => ms > 900 && ms <= 1000)).toBe(true); // 60/min = one call a second
  });
});

describe('incomplete shop risk evidence', () => {
  it('retains known alerts while incomplete coverage takes exit 3 precedence', async () => {
    const store: any = { listings: [{ id: 'fixture', title: 'Known Fixture', tags: [] }], alerts: [], lastScanAt: null };
    const result = await scanListings(store, { perMinute: 0, includeDescription: true, check: async () => ({ status: 'risk', incomplete: true, reason: 'EU coverage unavailable', text: 'fixture', classes: ['025'], jurisdictions: ['US', 'EUIPO'], informational: [], disclaimer: 'Risk screening fixture', actionable: [{ wordmark: 'KNOWN FIXTURE', jurisdiction: 'US', serial_number: 'synthetic', international_class: '025', registration_status: 'registered' }] }) });
    expect(result.risk).toBe(1); expect(result.incomplete).toBe(1); expect(result.coverageComplete).toBe(false);
    expect(result.newAlerts).toHaveLength(1); expect(store.alerts).toHaveLength(1); expect(store.listings[0].lastScan.incomplete).toBe(true);
    expect(result.coverageGaps[0].reason).toBe('EU coverage unavailable'); expect(scanCompletionExitCode(result)).toBe(3);
  });
  it('complete new risk remains exit 2 and complete clear remains 0', () => {
    expect(scanCompletionExitCode({ unverified: 0, incomplete: 0, newAlerts: [{}] })).toBe(2);
    expect(scanCompletionExitCode({ unverified: 0, incomplete: 0, newAlerts: [] })).toBe(0);
    expect(scanCompletionExitCode({ unverified: 1, incomplete: 1, newAlerts: [{}] })).toBe(3);
  });
});

describe('Merch brand and field boundaries', () => {
  it('imports/persists optional CSV brand and screens brand/description as separate fields', async () => {
    const file = path.join(home, 'merch.csv'); fs.writeFileSync(file, 'Title,Brand,Description\nKnown,Brand,Fixture description\n');
    const store = loadStore(env); importListings(store, recordsFromFile(file)); saveStore(store, env);
    expect(loadStore(env).listings[0].brand).toBe('Brand');
    const seen: any[] = [];
    await scanListings(store, { perMinute: 0, includeDescription: true, check: (async (input: any) => { seen.push(input); return { status: 'clear', actionable: [] }; }) as never });
    expect(seen[0].fields).toEqual([{ id: 'title', name: 'Title', content: 'Known' }, { id: 'brand', name: 'Brand', content: 'Brand' }, { id: 'description', name: 'Description', content: 'Fixture description' }]);
    expect(store.listings[0].lastScan.brandIncluded).toBe(true);
  });
  it.each([false, true])('preserves brand-only known hits with degraded coverage=%s and never combines fields', async degraded => {
    const { checkText } = await import('@/cli/lib/trademark.mjs'); const realFetch = globalThis.fetch; const requested: string[] = [];
    globalThis.fetch = (async (_url: any, options: any) => {
      const text = JSON.parse(options.body).text; requested.push(text);
      const hit = text === 'KNOWN BRAND' ? [{ wordmark: 'KNOWN BRAND', matched_text: 'known brand', serial_number: 'synthetic-brand', international_class: '025', jurisdiction: 'US', registration_status: 'registered', confidence: 'high' }] : [];
      return new Response(JSON.stringify({ matches: hit, data_stale: degraded, jurisdictions_checked: degraded ? ['US'] : ['US', 'EUIPO'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const result = await checkText({ fields: [{ id: 'title', name: 'Title', content: 'Plain art' }, { id: 'brand', name: 'Brand', content: 'KNOWN BRAND' }], text: 'Plain art', classes: ['025'], apiBase: 'http://127.0.0.1:9' });
      expect(result.actionable.some((m: any) => m.wordmark === 'KNOWN BRAND')).toBe(true); expect(result.status).toBe('risk'); if(degraded) expect(result.incomplete).toBe(true);
      expect(requested.every(text => text === 'Plain art' || text === 'KNOWN BRAND')).toBe(true);
    } finally { globalThis.fetch = realFetch; }
  });
});

it('reimporting changed brand invalidates old screening but preserves known alerts', () => {
  const store: any = { listings: [], alerts: [{ key: 'known-alert' }] };
  importListings(store, [{ id: 'fixture', title: 'Art', brand: 'First Brand' }]);
  store.listings[0].lastScan = { status: 'clear', incomplete: false, brandIncluded: true };
  importListings(store, [{ id: 'fixture', title: 'Art', brand: 'Changed Brand' }]);
  expect(store.listings[0].lastScan).toBeNull(); expect(store.alerts).toHaveLength(1);
});

it('does not invent a trademark phrase across title and brand boundaries', async () => {
  const { checkText } = await import('@/cli/lib/trademark.mjs'); const original = globalThis.fetch; const requested: string[] = [];
  globalThis.fetch = (async (_url: any, options: any) => { const text = JSON.parse(options.body).text; requested.push(text); return new Response(JSON.stringify({ matches: text.includes('KNOWN BRAND') ? [{ wordmark: 'KNOWN BRAND' }] : [], data_stale: false, jurisdictions_checked: ['US', 'EUIPO'] }), { status: 200 }); }) as typeof fetch;
  try {
    const result = await checkText({ fields: [{ id: 'title', name: 'Title', content: 'KNOWN' }, { id: 'brand', name: 'Brand', content: 'BRAND' }], classes: ['025'], apiBase: 'http://127.0.0.1:9' });
    expect(result.status).toBe('clear'); expect(result.actionable).toHaveLength(0); expect(requested.every(text => text === 'KNOWN' || text === 'BRAND')).toBe(true);
  } finally { globalThis.fetch = original; }
});

it('preserves same-title rows with distinct screened content and keeps identical reimports stable', () => {
  const store: any = { listings: [], alerts: [{ key: 'prior-known-alert' }] };
  const rows = [{ title: 'Same Title', tags: ['first phrase'], description: 'first description' }, { title: 'Same Title', tags: ['second phrase'], description: 'second description' }];
  expect(importListings(store, rows)).toMatchObject({ added: 2, updated: 0, total: 2 });
  expect(new Set(store.listings.map((row: any) => row.id)).size).toBe(2);
  const ids = store.listings.map((row: any) => row.id);
  expect(importListings(store, rows)).toMatchObject({ added: 0, updated: 2, total: 2 }); expect(store.listings.map((row: any) => row.id)).toEqual(ids);
  expect(store.alerts).toHaveLength(1);
  expect(importListings(store, [rows[0]]).total).toBe(2);
});
