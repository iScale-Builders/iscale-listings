import { describe, expect, it } from 'vitest';
import {
  displayMatches,
  isFamousSingleWord,
  tierOf,
  type TrademarkMatch,
} from '../../extension/shared';
import { FAMOUS_SINGLE_WORD_BRANDS } from '../../listing-core-runtime/src/core/listing/famousSingleWordPolicy';

function match(wordmark: string, confidence: 'high' | 'low' = 'high'): TrademarkMatch {
  return {
    wordmark,
    matched_text: wordmark.toLowerCase(),
    serial_number: '1',
    international_class: '025',
    owner: 'Owner',
    status: 'LIVE',
    confidence,
    tsdr_url: 'https://example.com',
  };
}

describe('ordinary single-word policy', () => {
  it('hides ordinary single-word records but never hides a famous brand', () => {
    const ordinary = match('FEATURING');
    const famous = match('NIKE', 'low');
    expect(displayMatches([ordinary, famous], true)).toEqual([famous]);
    expect(isFamousSingleWord(famous)).toBe(true);
    expect(tierOf(famous)).toBe('low');
    expect(tierOf(ordinary)).toBe('faint');
  });

  it('uses the shared core policy for every famous-brand exception', () => {
    for (const brand of FAMOUS_SINGLE_WORD_BRANDS) {
      expect(isFamousSingleWord(match(brand.toUpperCase(), 'low'))).toBe(true);
    }
  });
});
