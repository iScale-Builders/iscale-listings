// Behaviour-parity tests for the extracted pipeline orchestrator. The AI/network
// step functions are mocked, so these assert the ORCHESTRATION the extension used
// to own: step order, output→input wiring, auto-selection, validation-off
// passthrough, trademark gating + error capture, and max-fill-after-trademark.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeImage } from '../analysis/analyzeImage';
import { generateCandidates } from '../keywords/generateCandidates';
import { validateBatch } from '../validation/validateBatch';
import { rankKeywords } from '../keywords/rankKeywords';
import { generateListing } from '../listing/generateListing';
import { trademarkCheckAndRewrite } from '../listing/trademarkCheck';
import type {
  CandidateKeyword,
  GeneratedListing,
  ImageAnalysis,
  ListingConfig,
  ValidatedKeyword,
} from '../types';
import type { TrademarkReport } from '../listing/trademarkCheck';
import type { AIConfig } from '@/lib/ai-provider';
import {
  generateKeywords,
  runListingPipeline,
  appendKeywordsToListing,
  type PipelinePhase,
} from './runListingPipeline';

vi.mock('../analysis/analyzeImage');
vi.mock('../keywords/generateCandidates');
vi.mock('../validation/validateBatch');
vi.mock('../keywords/rankKeywords');
vi.mock('../listing/trademarkCheck');
// Keep enforceMaxFillListing real (the max-fill path exercises it); stub only the
// AI-calling generateListing.
vi.mock('../listing/generateListing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../listing/generateListing')>();
  return { ...actual, generateListing: vi.fn() };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const aiConfig: AIConfig = { provider: 'openai', apiKey: 'sk-test' };

const analysis: ImageAnalysis = {
  visualElements: ['cat'],
  detectedText: ['Monday Mood'],
  mood: 'funny',
  style: 'cartoon',
  colors: ['orange'],
  rawResponse: '{}',
};

const candidates: CandidateKeyword[] = [
  { id: 'c1', word: 'cat dad', source: 'who', isPhrase: true },
  { id: 'c2', word: 'cat', source: 'visual', isPhrase: false },
];

function vk(word: string, isPhrase: boolean, certified = true): ValidatedKeyword {
  return {
    id: `k-${word}`,
    word,
    source: 'who',
    isPhrase,
    subWords: isPhrase ? word.split(' ') : [],
    validations: [],
    certified,
    unverified: false,
    bestPosition: certified ? 1 : null,
    bestVariant: certified ? 'shirt' : null,
    selected: false,
  };
}

const ranked: ValidatedKeyword[] = [vk('cat dad', true), vk('cat', false)];

const listing: GeneratedListing = {
  fields: [
    {
      fieldId: 'title',
      fieldName: 'Title',
      content: 'Cat Dad',
      charCount: 7,
      maxChars: 60,
      keywordsUsed: ['cat dad'],
      certifiedCount: 1,
      fillerCount: 0,
    },
  ],
  metadata: {
    generatedAt: 'fixed',
    configUsed: {} as ListingConfig,
    totalCertifiedUsed: 1,
    totalFillerUsed: 0,
    validationStats: { totalCandidates: 2, totalChecks: 2, certifiedCount: 1, notFoundCount: 1 },
  },
};

const report: TrademarkReport = {
  clean: true,
  stale: false,
  iterations: 1,
  flaggedTerms: [],
  changes: [],
  originalListing: { title: 'Cat Dad' },
  finalListing: { title: 'Cat Dad' },
};

function makeConfig(overrides: Partial<ListingConfig> = {}): ListingConfig {
  return {
    fields: [{ id: 'title', name: 'Title', maxChars: 60 }],
    productType: 'shirt',
    productVariants: ['shirt', 'tshirt', 't-shirt'],
    customInstructions: '',
    forbiddenWords: ['shirt'],
    maxKeywords: 10,
    trademarkClasses: ['025'],
    presets: [],
    activePresetId: 'balanced',
    allowSingleWordTrademarks: false,
    maxFill: false,
    ...overrides,
  };
}

const autosuggest = vi.fn(async () => [] as string[]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(analyzeImage).mockResolvedValue(analysis);
  vi.mocked(generateCandidates).mockResolvedValue(candidates);
  vi.mocked(validateBatch).mockImplementation(async (_c, _f, _v, opts) => {
    opts?.onProgress?.(100);
    return ranked;
  });
  vi.mocked(rankKeywords).mockResolvedValue(ranked);
  vi.mocked(generateListing).mockResolvedValue(listing);
  vi.mocked(trademarkCheckAndRewrite).mockResolvedValue(report);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runListingPipeline', () => {
  it('runs the full auto flow in order and wires step outputs to inputs', async () => {
    const phases: PipelinePhase[] = [];
    const result = await runListingPipeline(
      {
        imageBase64: 'data:image/png;base64,xxx',
        aiConfig,
        config: makeConfig({ maxKeywords: 5 }),
        validateEnabled: true,
        trademarkEnabled: true,
      },
      { autosuggest, onPhase: (p) => phases.push(p) }
    );

    expect(analyzeImage).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      imageBase64: 'data:image/png;base64,xxx',
      aiConfig,
    });
    expect(generateCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test', analysis, aiConfig, forbiddenWords: ['shirt'] })
    );
    // The injected fetcher is what validateBatch receives — not a hard-coded one.
    expect(validateBatch).toHaveBeenCalledWith(
      candidates,
      autosuggest,
      ['shirt', 'tshirt', 't-shirt'],
      expect.objectContaining({ concurrency: 8 })
    );
    expect(rankKeywords).toHaveBeenCalledTimes(1);

    // generateListing gets the auto-selected keywords (phrase "cat dad" selected,
    // standalone "cat" suppressed because the phrase already covers it).
    const passedToListing = vi.mocked(generateListing).mock.calls[0][0].validatedKeywords;
    expect(passedToListing.find((k) => k.word === 'cat dad')?.selected).toBe(true);
    expect(passedToListing.find((k) => k.word === 'cat')?.selected).toBe(false);

    expect(result.analysis).toBe(analysis);
    expect(result.listing).toBe(listing);
    expect(result.trademark).toBe(report);
    expect(result.trademarkError).toBeNull();
    expect(result.rankingSkipped).toBe(false);
    expect(phases).toEqual(['analyze', 'generate', 'validate', 'validate', 'rank', 'listing']);
  });

  it('skips validation + ranking when validateEnabled is false (passthrough)', async () => {
    const result = await runListingPipeline(
      {
        imageBase64: 'x',
        aiConfig,
        config: makeConfig(),
        validateEnabled: false,
        trademarkEnabled: false,
      },
      { autosuggest: null }
    );

    expect(validateBatch).not.toHaveBeenCalled();
    expect(rankKeywords).not.toHaveBeenCalled();
    // Passthrough keeps both candidates, uncertified.
    expect(result.validated.map((k) => k.word).sort()).toEqual(['cat', 'cat dad']);
    expect(result.validated.every((k) => k.certified === false)).toBe(true);
    expect(result.rankingSkipped).toBe(false);
  });

  it('does not run the trademark pass when trademarkEnabled is false', async () => {
    const result = await runListingPipeline(
      { imageBase64: 'x', aiConfig, config: makeConfig(), validateEnabled: true, trademarkEnabled: false },
      { autosuggest }
    );
    expect(trademarkCheckAndRewrite).not.toHaveBeenCalled();
    expect(result.trademark).toBeNull();
    expect(result.trademarkError).toBeNull();
  });

  it('captures a trademark failure without losing the listing', async () => {
    vi.mocked(trademarkCheckAndRewrite).mockRejectedValueOnce(new Error('TM API down'));
    const result = await runListingPipeline(
      { imageBase64: 'x', aiConfig, config: makeConfig(), validateEnabled: true, trademarkEnabled: true },
      { autosuggest }
    );
    expect(result.listing).toBe(listing);
    expect(result.trademark).toBeNull();
    expect(result.trademarkError).toBe('TM API down');
  });

  it('propagates rankingSkipped when the ranker reports a skip', async () => {
    vi.mocked(rankKeywords).mockImplementationOnce(async (opts) => {
      opts.onRankingSkipped?.('ranking response was not valid JSON');
      return ranked;
    });
    const result = await runListingPipeline(
      { imageBase64: 'x', aiConfig, config: makeConfig(), validateEnabled: true, trademarkEnabled: false },
      { autosuggest }
    );
    expect(result.rankingSkipped).toBe(true);
  });

  it('applies max-fill to the trademark-clean final listing when maxFill is on', async () => {
    vi.mocked(trademarkCheckAndRewrite).mockResolvedValueOnce({
      ...report,
      finalListing: { title: 'Cat Dad' },
    });
    const result = await runListingPipeline(
      {
        imageBase64: 'x',
        aiConfig,
        config: makeConfig({ maxFill: true }),
        validateEnabled: true,
        trademarkEnabled: true,
      },
      { autosuggest }
    );
    // applyTrademarkFinalMaxFill rebuilds finalListing through the real
    // enforceMaxFillListing: the title field still exists and stays within limit,
    // and the padded content is at least the original length.
    expect(result.trademark?.finalListing.title).toBeDefined();
    expect(result.trademark!.finalListing.title.length).toBeGreaterThanOrEqual('Cat Dad'.length);
    expect(result.trademark!.finalListing.title.length).toBeLessThanOrEqual(60);
  });
});

describe('generateKeywords', () => {
  it('returns ranked keywords without auto-selecting (manual prefix)', async () => {
    const result = await generateKeywords(
      { imageBase64: 'x', aiConfig, config: makeConfig(), validateEnabled: true },
      { autosuggest }
    );
    expect(result.analysis).toBe(analysis);
    expect(result.ranked).toBe(ranked);
    expect(result.ranked.every((k) => k.selected === false)).toBe(true);
  });

  it('throws if validation is enabled without an autosuggest fetcher', async () => {
    await expect(
      generateKeywords(
        { imageBase64: 'x', aiConfig, config: makeConfig(), validateEnabled: true },
        { autosuggest: null }
      )
    ).rejects.toThrow(/autosuggest fetcher/);
  });
});

describe('appendKeywordsToListing', () => {
  const baseListing = {
    fields: [
      {
        fieldId: 'title',
        fieldName: 'Title',
        content: 'Cat Dad',
        charCount: 7,
        maxChars: 60,
        keywordsUsed: ['cat dad'],
        certifiedCount: 1,
        fillerCount: 0,
      },
    ],
    metadata: {
      generatedAt: 'fixed',
      configUsed: {} as ListingConfig,
      totalCertifiedUsed: 1,
      totalFillerUsed: 0,
      validationStats: { totalCandidates: 0, totalChecks: 0, certifiedCount: 0, notFoundCount: 0 },
    },
  };

  it('pads the listing itself when there is no trademark report', () => {
    const r = appendKeywordsToListing({
      listing: baseListing,
      trademark: null,
      keywords: [vk('cat dad', true), vk('grumpy feline', true)],
      config: makeConfig(),
    });
    expect(r.finalListing).toBeNull();
    expect(r.listing.fields[0].content.length).toBeGreaterThanOrEqual('Cat Dad'.length);
    expect(r.listing.fields[0].content.length).toBeLessThanOrEqual(60);
  });

  it('writes into finalListing and never re-adds a trademark-blocked keyword', () => {
    const trademark = {
      clean: false,
      stale: false,
      iterations: 1,
      flaggedTerms: ['NIKE'],
      changes: [],
      originalListing: { title: 'Cat Dad' },
      finalListing: { title: 'Cat Dad' },
    };
    const r = appendKeywordsToListing({
      listing: baseListing,
      trademark,
      keywords: [vk('cat dad', true), { ...vk('nike', false), selected: true }],
      config: makeConfig(),
    });
    expect(r.listing).toBe(baseListing); // listing untouched; the rewrite owns content
    expect(r.finalListing?.title).toBeDefined();
    expect(r.finalListing!.title.toLowerCase()).not.toContain('nike');
  });
});
