import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountIdFromHtml, exportStatus, runExport, writeCatalogFiles } from '@/cli/lib/merch.mjs';
import { importListings, recordsFromFile } from '@/cli/lib/monitor.mjs';

const listing = (i: number, extra: Record<string, unknown> = {}) => ({
  asin: `B0TEST${String(i).padStart(4, '0')}`, marketplace: 'US', status: 'PUBLISHED', productType: 'STANDARD_TSHIRT',
  productTitle: `Funny Cat Design ${i}`, brandName: `Cat Brand ${i}`, listPrice: 19.99, currencyCode: 'USD',
  designId: `design-${i}`, listingId: `listing-${i}`, createdDate: 1788825969.85, updatedDate: 1788825968.9, ...extra,
});

/** A fake Merch: `pages` pages of rows, page tokens like the real service, optional failures. */
function fakeMerch(pages: unknown[][], { failOnPage = 0, failTimes = Infinity, status = 500 } = {}) {
  const calls: { pageToken: unknown }[] = [];
  let failures = 0;
  return {
    calls,
    getAccountId: async () => '12345',
    fetchPage: async (body: { pageToken: string[]; accountId: string }) => {
      expect(body.accountId).toBe('12345');
      const index = body.pageToken.length ? Number(body.pageToken[0].replace('p', '')) : 0;
      calls.push({ pageToken: body.pageToken });
      if (index + 1 === failOnPage && failures < failTimes) {
        failures += 1;
        return { status, json: null };
      }
      const next = index + 1 < pages.length ? [`p${index + 1}`] : [];
      return { status: 200, json: { hitCount: pages.flat().length, results: pages[index] ?? [], pageToken: next } };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-merch-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fast = { paceMs: 0, retryDelayMs: 0 };
const pagesOf = (n: number, per = 3) => Array.from({ length: n }, (_, p) => Array.from({ length: per }, (_, i) => listing(p * per + i)));

describe('merch catalog export', () => {
  it('reads the account id Merch embeds in its pages', () => {
    expect(accountIdFromHtml(`return {"customerId":"A1","customerRole":"ADMIN","accountId":"87654321","businessName":null}`)).toBe('87654321');
    expect(accountIdFromHtml('<html>Sign in</html>')).toBeNull();
  });

  it('pages through everything and writes the catalog files', async () => {
    const merch = fakeMerch(pagesOf(3));
    const state = await runExport({ dir, ...merch, ...fast });
    expect(state).toMatchObject({ done: true, pages: 3, rows: 9, hitCount: 9, accountId: '12345' });
    const files = await writeCatalogFiles(dir);
    expect(files).toMatchObject({ listings: 9, liveTitles: 9 });
    const csv = fs.readFileSync(path.join(dir, 'merch-catalog.csv'), 'utf8').trim().split('\n');
    expect(csv[0]).toBe('asin,marketplace,status,productType,title,brand,listPrice,currencyCode,designId,listingId,createdDate,updatedDate,deleteReasonType,lockReasonType,searchableOnRetail');
    expect(csv).toHaveLength(10);
    expect(csv[1]).toContain('B0TEST0000,US,PUBLISHED,STANDARD_TSHIRT,Funny Cat Design 0,Cat Brand 0,19.99,USD,design-0,listing-0,2026-');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'merch-catalog.json'), 'utf8'))).toHaveLength(9);
  });

  it('stops on a failure without losing anything, then continues from the same page', async () => {
    const pages = pagesOf(4);
    const first = fakeMerch(pages, { failOnPage: 3 });
    await expect(runExport({ dir, ...first, ...fast })).rejects.toThrow(/Nothing is lost: run iscale merch export again to continue from page 3/);
    expect(exportStatus(dir)).toMatchObject({ started: true, done: false, pages: 2, rows: 6 });

    const second = fakeMerch(pages);
    const state = await runExport({ dir, ...second, ...fast });
    expect(second.calls[0].pageToken).toEqual(['p2']);
    expect(state).toMatchObject({ done: true, pages: 4, rows: 12 });
    expect((await writeCatalogFiles(dir)).listings).toBe(12);
  });

  it('retries a temporary error (429/5xx) without stopping', async () => {
    const merch = fakeMerch(pagesOf(2), { failOnPage: 2, failTimes: 2, status: 429 });
    const state = await runExport({ dir, ...merch, ...fast });
    expect(state).toMatchObject({ done: true, rows: 6 });
  });

  it('drops a half-saved page left by a crash between the two writes', async () => {
    const pages = pagesOf(3);
    await runExport({ dir, ...fakeMerch(pages), ...fast, maxPages: 1 });
    fs.appendFileSync(path.join(dir, 'catalog.ndjson'), JSON.stringify(pages[1]) + '\n');
    await runExport({ dir, ...fakeMerch(pages), ...fast });
    const lines = fs.readFileSync(path.join(dir, 'catalog.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect((await writeCatalogFiles(dir)).listings).toBe(9);
  });

  it('asks for a new sign-in when Merch refuses, and keeps the progress', async () => {
    const pages = pagesOf(3);
    await expect(runExport({ dir, ...fakeMerch(pages, { failOnPage: 2, status: 401 }), ...fast })).rejects.toThrow(/sign-in expired. Run: iscale merch login.*continues at page 2/);
    expect(exportStatus(dir)).toMatchObject({ pages: 1, rows: 3 });
  });

  it('refuses to start when not signed in', async () => {
    await expect(runExport({ dir, getAccountId: async () => null, fetchPage: async () => ({ status: 200, json: {} }), ...fast })).rejects.toThrow(/Run: iscale merch login/);
  });

  it('live file: published only, one row per title, ready for listings import', async () => {
    const rows = [listing(1), listing(2, { marketplace: 'DE', listingId: 'listing-2-de', asin: 'B0DE' }), listing(1, { listingId: 'listing-1-mug', productType: 'MUG' }), listing(3, { status: 'DELETED' }), listing(4, { productTitle: 'Say "Hi", Friend' })];
    await runExport({ dir, ...fakeMerch([rows]), ...fast });
    const files = await writeCatalogFiles(dir);
    expect(files).toMatchObject({ listings: 5, liveTitles: 3 });
    const store = { listings: [] as { id: string; title: string; tags: string[] }[] };
    const r = importListings(store, recordsFromFile(path.join(dir, 'merch-catalog-live.csv')), { source: 'merch' });
    expect(r).toMatchObject({ added: 3, skipped: 0 });
    expect(store.listings.map((l) => l.title)).toEqual(['Funny Cat Design 1', 'Funny Cat Design 2', 'Say "Hi", Friend']);
    expect(store.listings[0]).toMatchObject({ id: expect.stringMatching(/^merch:content:[a-f0-9]{64}$/), brand: 'Cat Brand 1', tags: ['Cat Brand 1'] });
  });

  it('running again after a finished export refreshes it (audit 2026-10-07)', async () => {
    await runExport({ dir, ...fakeMerch(pagesOf(2)), ...fast });
    const again = fakeMerch(pagesOf(3));
    const state = await runExport({ dir, ...again, ...fast });
    expect(again.calls.length).toBe(3);
    expect(state).toMatchObject({ done: true, pages: 3, rows: 9, previousFinishedAt: expect.any(String) });
    expect((await writeCatalogFiles(dir)).listings).toBe(9);
  });

  it('--restart starts a fresh export', async () => {
    await runExport({ dir, ...fakeMerch(pagesOf(2)), ...fast });
    const state = await runExport({ dir, ...fakeMerch(pagesOf(1)), ...fast, restart: true });
    expect(state).toMatchObject({ done: true, pages: 1, rows: 3 });
  });
});

it('keeps localized title/brand variants of one design distinct through live export/import and repeat import', async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-merch-identity-'));
  try {
    const rows = [listing(1, { designId: 'shared-design', productTitle: 'English Title', brandName: 'English Brand' }), listing(2, { designId: 'shared-design', productTitle: 'Localized Title', brandName: 'Localized Brand' })];
    await runExport({ dir: localDir, ...fakeMerch([rows]), ...fast });
    expect((await writeCatalogFiles(localDir)).liveTitles).toBe(2);
    const records = recordsFromFile(path.join(localDir, 'merch-catalog-live.csv')); const store: any = { listings: [], alerts: [] };
    expect(importListings(store, records)).toMatchObject({ added: 2, total: 2 });
    expect(new Set(store.listings.map((row: any) => row.id)).size).toBe(2); expect(store.listings.map((row: any) => row.brand)).toEqual(['English Brand', 'Localized Brand']);
    const ids = store.listings.map((row: any) => row.id);
    expect(importListings(store, records)).toMatchObject({ added: 0, updated: 2, total: 2 }); expect(store.listings.map((row: any) => row.id)).toEqual(ids);
  } finally { if (!path.resolve(localDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Cleanup ownership mismatch'); fs.rmSync(localDir, { recursive: true, force: true }); }
});
