import { describe, it, expect } from 'vitest';
import { buildExportResult } from './exportResult';
import type { GeneratedListing, ValidatedKeyword } from '../types';
import type { TrademarkReport } from '../listing/trademarkCheck';

function vk(word: string, over: Partial<ValidatedKeyword> = {}): ValidatedKeyword {
  return {
    id: `k-${word}`,
    word,
    source: 'who',
    isPhrase: word.includes(' '),
    subWords: [],
    validations: [],
    certified: true,
    unverified: false,
    bestPosition: 1,
    bestVariant: 'shirt',
    selected: true,
    ...over,
  };
}

const listing: GeneratedListing = {
  fields: [
    {
      fieldId: 'title',
      fieldName: 'Title',
      content: 'Nike Cat Dad',
      charCount: 12,
      maxChars: 60,
      keywordsUsed: ['cat dad'],
      certifiedCount: 1,
      fillerCount: 0,
    },
  ],
  metadata: {
    generatedAt: 'fixed',
    configUsed: {} as never,
    totalCertifiedUsed: 1,
    totalFillerUsed: 0,
    validationStats: { totalCandidates: 1, totalChecks: 1, certifiedCount: 1, notFoundCount: 0 },
  },
};

describe('buildExportResult', () => {
  it('recomputes keywordsUsed against the trademark-clean final content', () => {
    // Regression: exported keywordsUsed copied the pre-rewrite metadata, so a
    // keyword the rewrite removed still showed as "used".
    const trademark: TrademarkReport = {
      clean: true,
      stale: false,
      iterations: 1,
      flaggedTerms: ['NIKE'],
      changes: [{ original: 'Nike Cat Dad', replacement: 'Cat Dad', reason: 'NIKE is trademarked' }],
      originalListing: { title: 'Nike Cat Dad' },
      finalListing: { title: 'Cat Dad' },
    };
    const out = buildExportResult({ analysis: null, keywords: [vk('cat dad'), vk('nike')], listing, trademark });
    const used = out.listing!.fields[0].keywordsUsed;
    expect(used).toContain('cat dad');
    expect(used).not.toContain('nike'); // removed by the rewrite → gone from final content
  });

  it('folds the trademark rewrite into the exported field content', () => {
    const trademark: TrademarkReport = {
      clean: true,
      stale: false,
      iterations: 1,
      flaggedTerms: ['NIKE'],
      changes: [{ original: 'Nike Cat Dad', replacement: 'Cat Dad', reason: 'NIKE is trademarked' }],
      originalListing: { title: 'Nike Cat Dad' },
      finalListing: { title: 'Cat Dad' },
    };
    const out = buildExportResult({
      analysis: null,
      keywords: [vk('cat dad')],
      listing,
      trademark,
      appVersion: '0.5.78',
      createdAt: '2026-06-29T00:00:00.000Z',
    });

    expect(out.listing?.fields[0].content).toBe('Cat Dad'); // rewrite applied
    expect(out.listing?.fields[0].charCount).toBe('Cat Dad'.length);
    expect(out.trademark).toEqual({
      clean: true,
      stale: false,
      flaggedTerms: ['NIKE'],
      changes: [{ original: 'Nike Cat Dad', replacement: 'Cat Dad', reason: 'NIKE is trademarked' }],
    });
    expect(out.keywords).toEqual([
      { word: 'cat dad', source: 'who', certified: true, selected: true, unverified: false },
    ]);
    expect(out.app_version).toBe('0.5.78');
    expect(out.created_at).toBe('2026-06-29T00:00:00.000Z');
    expect(out.review_actions).toEqual([]); // clean, non-stale
  });

  it('uses generated content when there is no trademark rewrite', () => {
    const out = buildExportResult({ analysis: null, keywords: [], listing, trademark: null });
    expect(out.listing?.fields[0].content).toBe('Nike Cat Dad');
    expect(out.trademark).toBeNull();
    expect(out.app_version).toBeNull();
    expect(out.created_at).toBeNull();
  });

  it('derives review actions for stale, still-flagged, error, and unverified states', () => {
    const stale = buildExportResult({
      analysis: null,
      keywords: [],
      listing,
      trademark: { clean: false, stale: true, iterations: 1, flaggedTerms: [], changes: [], originalListing: {}, finalListing: {} },
    });
    expect(stale.review_actions.some((a) => a.includes('stale'))).toBe(true);

    const flagged = buildExportResult({
      analysis: null,
      keywords: [],
      listing,
      trademark: { clean: false, stale: false, iterations: 3, flaggedTerms: ['DISNEY'], changes: [], originalListing: {}, finalListing: {} },
    });
    expect(flagged.review_actions.some((a) => a.includes('DISNEY'))).toBe(true);

    const errored = buildExportResult({ analysis: null, keywords: [], listing, trademark: null, trademarkError: 'TM API down' });
    expect(errored.review_actions.some((a) => a.includes('TM API down'))).toBe(true);

    const unverified = buildExportResult({
      analysis: null,
      keywords: [vk('cat', { certified: false, unverified: true, selected: false })],
      listing,
      trademark: null,
    });
    expect(unverified.review_actions.some((a) => a.includes('could not be verified'))).toBe(true);
  });

  it('returns a null listing when nothing was generated', () => {
    const out = buildExportResult({ analysis: null, keywords: [], listing: null, trademark: null });
    expect(out.listing).toBeNull();
  });
});
