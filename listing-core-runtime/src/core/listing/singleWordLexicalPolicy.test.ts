import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionableMatches, screenTermsForTrademarks, type TrademarkMatch } from './trademarkCheck';
afterEach(() => vi.unstubAllGlobals());
const cases = [
  { wordmark: '& STYLE', term: 'style', ordinarySingle: true },
  { wordmark: 'STYLE &', term: 'style', ordinarySingle: true },
  { wordmark: '& NIKE', term: 'nike', ordinarySingle: false },
  { wordmark: 'NIKE &', term: 'nike', ordinarySingle: false },
  { wordmark: 'FRUIT & COCKTAIL', term: 'fruit cocktail', ordinarySingle: false },
  { wordmark: 'FRUIT&COCKTAIL', term: 'fruit cocktail', ordinarySingle: false },
  { wordmark: 'TROPICAL VIBES', term: 'tropical vibes', ordinarySingle: false },
];
describe('canonical lexical single-word policy', () => {
  it.each(cases)('preserves listing and keyword policy for $wordmark', async ({ wordmark, term, ordinarySingle }) => {
    const match: TrademarkMatch = { wordmark, matched_text: term, serial_number: 'fixture', registration_status: 'registered', international_class: '009', jurisdiction: 'US', confidence: 'high', owner: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ matches: [match], total_matches: 1, data_stale: false, truncated: false, jurisdictions_checked: ['US'] }), { status: 200 })));
    for (const allowSingleWord of [true, false]) {
      const expected = !allowSingleWord || !ordinarySingle;
      expect(getActionableMatches([match], allowSingleWord)).toHaveLength(expected ? 1 : 0);
      const screened = await screenTermsForTrademarks([term], ['009'], allowSingleWord, ['US']);
      expect(screened.stale).toBe(false);
      expect(screened.flagged.has(term)).toBe(expected);
    }
  });
});
