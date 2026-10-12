import { describe, it, expect } from 'vitest';
import {
  chunkByWords,
  MAX_WORDS_PER_CHUNK,
  matchAccumKey,
  mergeMatches,
  dedupeMatches,
  classifyMerchField,
  isMerchEditorHost,
  isTrademarkSafeForAutofill,
  splitMatchParts,
  outermostElements,
} from '@/extension/scan-core';
import { MAX_WORDS_PER_CHECK_REQUEST } from '@/listing-core-runtime/src/core/listing/constants';
import { trademarkStatusTone } from '@/extension/categories';
import type { TrademarkMatch } from '@/extension/shared';

function match(overrides: Partial<TrademarkMatch> = {}): TrademarkMatch {
  return {
    wordmark: 'ACME',
    matched_text: 'acme',
    serial_number: '1000',
    international_class: '025',
    owner: 'Acme Inc',
    status: 'live',
    confidence: 'high',
    tsdr_url: 'https://tsdr.uspto.gov/#caseNumber=1000',
    ...overrides,
  };
}

describe('chunkByWords', () => {
  it('keeps phrases under the limit in one chunk, newline-joined', () => {
    expect(chunkByWords(['red shirt', 'blue hat'], 110)).toEqual(['red shirt\nblue hat']);
  });

  it('splits into a new chunk when the word budget is exceeded', () => {
    // limit 3: "a b" (2) fits; adding "c d" (2) would make 4 → new chunk.
    expect(chunkByWords(['a b', 'c d'], 3)).toEqual(['a b', 'c d']);
  });

  it('packs as many phrases as fit before splitting', () => {
    expect(chunkByWords(['a', 'b', 'c', 'd'], 2)).toEqual(['a\nb', 'c\nd']);
  });

  it('sends an over-limit phrase out on its own rather than dropping it', () => {
    expect(chunkByWords(['one two three four'], 2)).toEqual(['one two three four']);
  });

  it('returns [] for no phrases', () => {
    expect(chunkByWords([], 110)).toEqual([]);
  });

  it('is single-sourced from the core so the scanner and listing check cannot drift', () => {
    // The scanner used to hard-code 110 while the core keyword screen used 80 —
    // two magic numbers for one server contract. Both now derive from the core.
    expect(MAX_WORDS_PER_CHUNK).toBe(MAX_WORDS_PER_CHECK_REQUEST);
    // and it's the default chunk budget
    const oneOverTheLimit = Array.from({ length: MAX_WORDS_PER_CHUNK + 1 }, () => 'w');
    expect(chunkByWords(oneOverTheLimit)).toHaveLength(2);
  });
});

describe('matchAccumKey', () => {
  it('is identical for the same serial + class + matched text, normalizing class & case', () => {
    expect(matchAccumKey(match({ international_class: '25', matched_text: 'ACME' }))).toBe(
      matchAccumKey(match({ international_class: '025', matched_text: 'acme' }))
    );
  });

  it('differs when the matched text differs', () => {
    expect(matchAccumKey(match({ matched_text: 'acme' }))).not.toBe(
      matchAccumKey(match({ matched_text: 'acme co' }))
    );
  });
});

describe('mergeMatches', () => {
  it('appends only new matches and preserves order (existing first)', () => {
    const existing = [match({ serial_number: '1' })];
    const incoming = [match({ serial_number: '1' }), match({ serial_number: '2' })];
    const merged = mergeMatches(existing, incoming);
    expect(merged.map((m) => m.serial_number)).toEqual(['1', '2']);
  });

  it('does not mutate the existing array', () => {
    const existing = [match({ serial_number: '1' })];
    mergeMatches(existing, [match({ serial_number: '2' })]);
    expect(existing).toHaveLength(1);
  });

  it('treats a different matched text on the same mark as a new entry', () => {
    const merged = mergeMatches(
      [match({ serial_number: '1', matched_text: 'acme' })],
      [match({ serial_number: '1', matched_text: 'acme co' })]
    );
    expect(merged).toHaveLength(2);
  });
});

describe('dedupeMatches', () => {
  it('collapses the same mark matched on many page spans to one row', () => {
    const out = dedupeMatches([
      match({ matched_text: 'acme' }),
      match({ matched_text: 'acme store' }), // same serial+class+wordmark
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps marks that differ by wordmark', () => {
    const out = dedupeMatches([match({ wordmark: 'ACME' }), match({ wordmark: 'ACME CORP' })]);
    expect(out).toHaveLength(2);
  });
});

describe('classifyMerchField', () => {
  it('maps title and brand by id or name', () => {
    expect(classifyMerchField('title', 'Title')).toBe('title');
    expect(classifyMerchField('x', 'Product Title')).toBe('title');
    expect(classifyMerchField('brand', 'Brand')).toBe('brand');
  });

  it('classifies a "Bullet Point Description" field as a bullet, not a description', () => {
    expect(classifyMerchField('bullet-1', 'Bullet Point Description')).toBe('bullet');
  });

  it('maps feature/bullet ids and names to bullet', () => {
    expect(classifyMerchField('feature-1', 'Feature')).toBe('bullet');
  });

  it('maps a real description and returns null for unknown fields', () => {
    expect(classifyMerchField('desc', 'Description')).toBe('description');
    expect(classifyMerchField('keywords', 'Search Terms')).toBeNull();
  });
});

describe('trademarkStatusTone', () => {
  it('prioritizes pending registration status', () => {
    expect(trademarkStatusTone('pending', 'live')).toBe('pending');
  });

  it('treats cancelled/abandoned or dead as dead', () => {
    expect(trademarkStatusTone('cancelled', 'live')).toBe('dead');
    expect(trademarkStatusTone('abandoned', '')).toBe('dead');
    expect(trademarkStatusTone('', 'dead')).toBe('dead');
  });

  it('treats registered or live as live, and pending otherwise (never unknown)', () => {
    expect(trademarkStatusTone('registered', '')).toBe('live');
    expect(trademarkStatusTone('', 'live')).toBe('live');
    expect(trademarkStatusTone('', '')).toBe('pending');
  });
});

describe('isMerchEditorHost', () => {
  it('accepts the real Merch editor hosts', () => {
    expect(isMerchEditorHost('merch.amazon.com')).toBe(true);
    expect(isMerchEditorHost('merch.amazon.co.uk')).toBe(true);
    expect(isMerchEditorHost('merch.amazon.de')).toBe(true);
    expect(isMerchEditorHost('www.merch.amazon.com')).toBe(true);
  });

  it('rejects non-Merch Amazon hosts and lookalikes', () => {
    expect(isMerchEditorHost('amazon.com')).toBe(false);
    expect(isMerchEditorHost('sellercentral.amazon.com')).toBe(false);
    expect(isMerchEditorHost('notmerch.amazon.com')).toBe(false);
    expect(isMerchEditorHost('merch.amazon.com.evil.com')).toBe(false);
    expect(isMerchEditorHost('merch.amazonaws.com')).toBe(false);
    expect(isMerchEditorHost('etsy.com')).toBe(false);
    expect(isMerchEditorHost('')).toBe(false);
  });
});

describe('splitMatchParts', () => {
  it('highlights whole-word occurrences only', () => {
    const parts = splitMatchParts('the category cat ran', 'cat')!;
    expect(parts.filter((p) => p.isMatch).map((p) => p.text)).toEqual(['cat']);
  });

  it('does not highlight substrings inside larger words', () => {
    expect(splitMatchParts('my category is locate-able', 'cat')).toBeNull();
    expect(splitMatchParts('girlfriend forever', 'girl')).toBeNull();
  });

  it('matches case-insensitively and preserves original casing in parts', () => {
    const parts = splitMatchParts('ACME makes Acme things', 'acme')!;
    expect(parts.filter((p) => p.isMatch).map((p) => p.text)).toEqual(['ACME', 'Acme']);
  });

  it('matches at string edges and next to punctuation', () => {
    const parts = splitMatchParts('cat, the cat.', 'cat')!;
    expect(parts.filter((p) => p.isMatch)).toHaveLength(2);
    expect(parts[0]).toEqual({ text: 'cat', isMatch: true });
    expect(parts[parts.length - 1]).toEqual({ text: '.', isMatch: false });
  });

  it('handles multi-word needles with boundaries at the edges', () => {
    expect(
      splitMatchParts('just a girlfriend who loves', 'just a girl')
    ).toBeNull();
    const parts = splitMatchParts('just a girl who loves just a girl', 'just a girl')!;
    expect(parts.filter((p) => p.isMatch)).toHaveLength(2);
  });

  it('skips a substring hit and still finds a later whole-word hit', () => {
    const parts = splitMatchParts('cats scatter and cat sits', 'cat')!;
    expect(parts.filter((p) => p.isMatch).map((p) => p.text)).toEqual(['cat']);
  });

  it('returns null when the needle is absent entirely', () => {
    expect(splitMatchParts('nothing here', 'acme')).toBeNull();
  });
});

describe('isTrademarkSafeForAutofill', () => {
  const clean = { clean: true, stale: false };
  const flagged = { clean: false, stale: false };

  it('is safe only when screening is enabled AND the report is clean AND fresh', () => {
    expect(isTrademarkSafeForAutofill(clean, null, true)).toBe(true);
    expect(isTrademarkSafeForAutofill(flagged, null, true)).toBe(false);
  });

  it('a stale clean report is NOT definitive — never auto-fill it', () => {
    expect(isTrademarkSafeForAutofill({ clean: true, stale: true }, null, true)).toBe(false);
  });

  it('a null report with screening enabled means unscreened — do not auto-fill', () => {
    expect(isTrademarkSafeForAutofill(null, null, true)).toBe(false);
  });

  it('a screening error always blocks auto-fill, even when disabled', () => {
    expect(isTrademarkSafeForAutofill(clean, 'API down', true)).toBe(false);
    expect(isTrademarkSafeForAutofill(null, 'API down', false)).toBe(false);
  });

  it('screening disabled by the user means filling is their choice', () => {
    expect(isTrademarkSafeForAutofill(null, null, false)).toBe(true);
    expect(isTrademarkSafeForAutofill(flagged, null, false)).toBe(true);
  });
});

describe('outermostElements', () => {
  type N = { name: string; parentElement: N | null };
  const n = (name: string, parentElement: N | null = null): N => ({ name, parentElement });
  it('keeps only regions not inside another region, in order, without duplicates', () => {
    const page = n('page');
    const cardA = n('cardA', page);
    const innerA = n('innerA', cardA);
    const deepA = n('deepA', n('wrap', innerA));
    const cardB = n('cardB', page);
    const title = n('title', page);
    const out = outermostElements([cardA, innerA, deepA, cardB, cardB, title]);
    expect(out.map((x) => x.name)).toEqual(['cardA', 'cardB', 'title']);
  });
});
