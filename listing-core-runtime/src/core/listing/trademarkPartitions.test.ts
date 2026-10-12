import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForTrademarks } from './trademarkCheck';
import { DEFAULT_LISTING_CONFIG, type GeneratedListing } from '../types';
const content = Array.from({ length: 12 }, (_, index) => `word${index}`).join(' ');
const listing = { fields: [{ fieldId: 'title', fieldName: 'Title', content, maxChars: 200, charCount: content.length, keywordsUsed: [], certifiedCount: 0, fillerCount: 0 }], metadata: { configUsed: DEFAULT_LISTING_CONFIG } } as GeneratedListing;
const hit = { wordmark: content, matched_text: content, jurisdiction: 'EUIPO', serial_number: 'fixture', international_class: '025', registration_status: 'pending', confidence: 'high', owner: null };
afterEach(() => vi.unstubAllGlobals());
describe('complete class/registry partitions', () => {
  it('preserves all twelve-word text and unions every class/registry combination', async () => {
    const leaves: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.text).toBe(content);
      const capped = body.classes.length > 1 || body.jurisdictions.length > 1;
      if (!capped) leaves.push(`${body.classes[0]}:${body.jurisdictions[0]}`);
      const matched = !capped && body.classes[0] === '025' && body.jurisdictions[0] === 'EUIPO';
      return new Response(JSON.stringify({ matches: matched ? [hit] : [], total_matches: capped ? 215 : matched ? 1 : 0, truncated: capped, data_stale: false, jurisdictions_checked: body.jurisdictions }), { status: 200 });
    }));
    const result = await checkForTrademarks(listing, ['009', '025'], ['US', 'EUIPO']);
    expect(leaves.sort()).toEqual(['009:EUIPO', '009:US', '025:EUIPO', '025:US']);
    expect(result.data_stale).toBe(false);
    expect(result.matches).toEqual([hit]);
  });
  it.each(['stale', 'error', 'capped'])('preserves fresh alerts when another partition is %s', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const parent = body.classes.length > 1;
      const failed = !parent && body.classes[0] === '009';
      if (failed && failure === 'error') throw new Error('offline');
      const capped = parent || (failed && failure === 'capped');
      return new Response(JSON.stringify({ matches: !parent && !failed ? [hit] : [], total_matches: capped ? 215 : !parent && !failed ? 1 : 0, truncated: capped, data_stale: failed && failure === 'stale', jurisdictions_checked: ['EUIPO'] }), { status: 200 });
    }));
    const result = await checkForTrademarks(listing, ['009', '025'], ['EUIPO']);
    expect(result.data_stale).toBe(true);
    expect(result.matches).toEqual([hit]);
  });
});
