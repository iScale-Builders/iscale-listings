import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  getActionableMatches,
  attributeHitsToTerms,
  checkForTrademarks,
  chunkFieldText,
  rebuildListing,
  setTrademarkApiBase,
  screenTermsForTrademarks,
} from './trademarkCheck';
import type { TrademarkMatch } from './trademarkCheck';
import { FAMOUS_SINGLE_WORD_BRANDS } from './famousSingleWordPolicy';
import { DEFAULT_LISTING_CONFIG, type GeneratedListing } from '../types';
import { normalizeText } from '../../../../lib/trademark/normalize';
import { generateCandidates as serverNgrams } from '../../../../lib/trademark/ngrams';

function match(over: Partial<TrademarkMatch>): TrademarkMatch {
  return {
    wordmark: 'NIKE',
    matched_text: 'nike',
    serial_number: '123',
    registration_status: 'registered',
    international_class: '025',
    owner: 'Nike, Inc.',
    confidence: 'high',
    ...over,
  };
}

function listingWith(content: string): GeneratedListing {
  return {
    fields: [{
      fieldId: 'title',
      fieldName: 'Title',
      content,
      charCount: content.length,
      maxChars: 60,
      keywordsUsed: [],
      certifiedCount: 0,
      fillerCount: 0,
    }],
    metadata: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      configUsed: DEFAULT_LISTING_CONFIG,
      totalCertifiedUsed: 0,
      totalFillerUsed: 0,
      validationStats: { totalCandidates: 0, totalChecks: 0, certifiedCount: 0, notFoundCount: 0 },
    },
  };
}

describe('truncated keyword response recovery', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('bounds retry traffic and treats capped listing responses as unverified', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ matches: [], total_matches: 215, truncated: true, jurisdictions_checked: ['EUIPO'], data_stale: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await screenTermsForTrademarks(Array.from({ length: 300 }, (_, i) => `term${i}`), ['025'], true, ['EUIPO']);
    expect(result.stale).toBe(true);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(256);
    const listingResult = await checkForTrademarks(listingWith('pool party'), ['025'], ['EUIPO']);
    expect(listingResult.data_stale).toBe(true);
  });
  it('splits capped batches with identical scope and recovers omitted matches', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      const multiple = body.text.includes('\n');
      return new Response(JSON.stringify({ matches: !multiple && body.text === 'pool party' ? [match({ wordmark: 'Pool Party', matched_text: 'pool party', jurisdiction: 'EUIPO', registration_status: 'pending' })] : [], total_matches: multiple ? 215 : body.text === 'pool party' ? 1 : 0, truncated: multiple, jurisdictions_checked: ['EUIPO'], data_stale: false }), { status: 200 });
    }));
    const result = await screenTermsForTrademarks(['pool party', 'garden fun'], ['009', '025'], true, ['EUIPO']);
    expect(result.stale).toBe(false);
    expect(result.flagged.has('pool party')).toBe(true);
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request).toMatchObject({ classes: ['009', '025'], jurisdictions: ['EUIPO'] });
  });
  it('preserves known alerts and stays unverified when a single term remains capped or another request fails', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      if (body.text === 'garden fun') throw new Error('offline');
      return new Response(JSON.stringify({ matches: [match({ wordmark: 'Pool Party', matched_text: 'pool party' })], total_matches: 215, truncated: true, jurisdictions_checked: ['EUIPO'], data_stale: false }), { status: 200 });
    }));
    const result = await screenTermsForTrademarks(['pool party', 'garden fun'], ['025'], true, ['EUIPO']);
    expect(result.stale).toBe(true);
    expect(result.flagged.has('pool party')).toBe(true);
    expect(calls).toBe(3);
  });
});

describe('trademark API jurisdiction coverage (regression: EU false clear)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTrademarkApiBase('http://localhost:3000');
  });

  it('requests and requires both US and EUIPO coverage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      matches: [],
      total_matches: 0,
      query_time_ms: 4,
      data_stale: false,
      jurisdictions_checked: ['US', 'EUIPO'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkForTrademarks(listingWith('original cat artwork'))).resolves.toMatchObject({
      total_matches: 0,
      data_stale: false,
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.jurisdictions).toEqual(['US', 'EUIPO']);
  });

  it('fails closed when the API checks US but omits EUIPO', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      matches: [],
      total_matches: 0,
      query_time_ms: 3,
      data_stale: false,
      jurisdictions_checked: ['US'],
      official_lookup_actions: [{ jurisdiction: 'EUIPO' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(checkForTrademarks(listingWith('original cat artwork'))).resolves.toMatchObject({ data_stale: true });
  });

  it('preserves US and EUIPO matches when their registry identifiers overlap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      matches: [
        match({ jurisdiction: 'US', serial_number: '123' }),
        match({ jurisdiction: 'EUIPO', serial_number: '123' }),
      ],
      total_matches: 2,
      query_time_ms: 5,
      data_stale: false,
      jurisdictions_checked: ['US', 'EUIPO'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const result = await checkForTrademarks(listingWith('nike artwork'));
    expect(result.matches.map((item) => item.jurisdiction)).toEqual(['US', 'EUIPO']);
  });
});

describe('adaptive listing truncation coverage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('preserves every server ngram through normalized punctuation boundaries', async () => {
    const content = Array.from({ length: 55 }, (_, index) => `wörd${index}`).join('-');
    const normalized = normalizeText(content);
    const completeTexts: string[] = [];
    const requestScopes: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requestScopes.push(body);
      const truncated = body.text.split(' ').length > 20;
      if (!truncated) completeTexts.push(body.text);
      return new Response(JSON.stringify({ matches: [], total_matches: truncated ? 215 : 0, truncated, data_stale: false, jurisdictions_checked: ['EUIPO'] }), { status: 200 });
    }));
    const result = await checkForTrademarks(listingWith(content), ['009', '025'], ['EUIPO']);
    expect(result.data_stale).toBe(false);
    const covered = new Set(completeTexts.flatMap(text => serverNgrams(text).candidates));
    for (const ngram of serverNgrams(normalized).candidates) expect(covered.has(ngram), ngram).toBe(true);
    for (const request of requestScopes) {
      expect(request.jurisdictions).toEqual(['EUIPO']);
      expect((request.classes as string[]).every(value => ['009', '025'].includes(value))).toBe(true);
    }
  });
  it('retains parent stale status and known alerts when children complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); const parent = body.text.split(' ').length > 12;
      return new Response(JSON.stringify({ matches: parent ? [match({ wordmark: 'Pool Party', matched_text: 'pool party' })] : [], total_matches: parent ? 215 : 0, truncated: parent, data_stale: parent, jurisdictions_checked: ['EUIPO'] }), { status: 200 });
    }));
    const result = await checkForTrademarks(listingWith('pool party ' + Array.from({ length: 18 }, (_, i) => `word${i}`).join(' ')), ['025'], ['EUIPO']);
    expect(result.data_stale).toBe(true);
    expect(result.matches).toHaveLength(1);
  });
  it('limits traffic and stays unverified for irreducible capped windows', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ matches: [match({})], total_matches: 215, truncated: true, data_stale: false, jurisdictions_checked: ['EUIPO'] }), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const result = await checkForTrademarks(listingWith(Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')), ['025'], ['EUIPO']);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(256);
    expect(result.data_stale).toBe(true);
    expect(result.matches).toHaveLength(1);
  });
  it('charges rate-limit retries against the physical request budget', async () => {
    vi.useFakeTimers();
    const mock = vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }));
    vi.stubGlobal('fetch', mock);
    const checking = checkForTrademarks(listingWith(Array.from({ length: 18000 }, (_, i) => `word${i}`).join(' ')), ['025'], ['EUIPO']);
    await vi.runAllTimersAsync();
    const result = await checking;
    expect(mock.mock.calls).toHaveLength(256);
    expect(result.data_stale).toBe(true);
  });
});

describe('getActionableMatches — plural vs. mark-plus-words (regression)', () => {
  it('FLAGS a registered mark when matched_text is the mark plus adjacent words', () => {
    // Regression: "nike air" was wrongly treated as a plural of NIKE and dropped,
    // producing a false "clear" — the worst failure mode for a screener.
    const out = getActionableMatches([match({ matched_text: 'nike air' })]);
    expect(out).toHaveLength(1);
    expect(out[0].wordmark).toBe('NIKE');
  });

  it('still allows a genuine plural/inflection on the same token', () => {
    // "champions" is a normal English word, not the CHAMPION mark — stays allowed.
    const out = getActionableMatches([
      match({ wordmark: 'CHAMPION', matched_text: 'champions', owner: 'X' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('flags an exact single-word match', () => {
    const out = getActionableMatches([match({ matched_text: 'nike' })]);
    expect(out).toHaveLength(1);
  });

  it('flags a multi-word mark when all its words are present', () => {
    const out = getActionableMatches([
      match({ wordmark: 'JUST DO IT', matched_text: 'just do it now' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('treats an ordinary single-word mark as informational when allowed', () => {
    const out = getActionableMatches([
      match({ wordmark: 'FEATURING', matched_text: 'featuring', owner: 'X' }),
    ], true);
    expect(out).toHaveLength(0);
  });

  it('keeps a famous single-word brand actionable even when ordinary words are allowed', () => {
    const out = getActionableMatches([match({ matched_text: 'nike' })], true);
    expect(out).toHaveLength(1);
    expect(out[0].wordmark).toBe('NIKE');
  });

  it('keeps every shared famous-brand exception actionable', () => {
    for (const brand of FAMOUS_SINGLE_WORD_BRANDS) {
      const out = getActionableMatches([
        match({ wordmark: brand.toUpperCase(), matched_text: brand, confidence: 'low' }),
      ], true);
      expect(out).toHaveLength(1);
    }
  });

  it('drops non-registered matches', () => {
    expect(getActionableMatches([match({ registration_status: 'abandoned' })])).toHaveLength(0);
  });

  it('FLAGS a famous short single-word mark scored low-confidence (regression: false clear)', () => {
    // classifyConfidence scores every single word < 5 chars as 'low' (NIKE, VANS,
    // GAP, KIA…). The listing check must NOT drop these on confidence — doing so
    // silently cleared famous registered marks while the keyword screen flagged
    // them. A registered exact whole-word match is actionable regardless of length.
    const out = getActionableMatches([match({ confidence: 'low' })]);
    expect(out).toHaveLength(1);
    expect(out[0].wordmark).toBe('NIKE');
  });
});

describe('getActionableMatches — punctuated wordmarks (regression: false clear)', () => {
  it('FLAGS an apostrophe mark whose matched_text was punctuation-folded', () => {
    // "Levi's" normalizes to "levis"; comparing the raw wordmark "LEVI'S" against
    // the folded "levis" used to fail the whole-word check and silently clear it.
    const out = getActionableMatches([
      match({ wordmark: "LEVI'S", matched_text: 'levis', owner: 'Levi Strauss & Co.' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wordmark).toBe("LEVI'S");
  });

  it('FLAGS a hyphenated mark typed without the hyphen', () => {
    const out = getActionableMatches([
      match({ wordmark: 'COCA-COLA', matched_text: 'coca cola', owner: 'The Coca-Cola Company' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('FLAGS a multi-word apostrophe mark when all words are present', () => {
    const out = getActionableMatches([
      match({ wordmark: "VICTORIA'S SECRET", matched_text: 'victorias secret', owner: 'X' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('still requires ALL words of a multi-word punctuated mark', () => {
    // Only "victorias" present — "secret" missing — must NOT flag.
    const out = getActionableMatches([
      match({ wordmark: "VICTORIA'S SECRET", matched_text: 'victorias', owner: 'X' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('attributeHitsToTerms — plural & punctuated keyword mapping (regression: false clear)', () => {
  it('maps a plural keyword back to the singular mark the API returned', () => {
    // The API de-pluralizes the query "nikes" -> candidate "nike" and returns
    // matched_text "nike"; the term "nikes" must still be flagged, not dropped.
    const flagged = attributeHitsToTerms(['nikes'], [match({ matched_text: 'nike' })]);
    expect(flagged.has('nikes')).toBe(true);
    expect(flagged.get('nikes')!.wordmark).toBe('NIKE');
  });

  it('maps an -ies plural keyword', () => {
    const flagged = attributeHitsToTerms(
      ['barbies'],
      [match({ wordmark: 'BARBIE', matched_text: 'barbie', owner: 'Mattel' })]
    );
    expect(flagged.has('barbies')).toBe(true);
  });

  it('maps a possessive keyword to a punctuation-folded mark', () => {
    const flagged = attributeHitsToTerms(
      ["levi's"],
      [match({ wordmark: "LEVI'S", matched_text: 'levis', owner: 'Levi Strauss & Co.' })]
    );
    expect(flagged.has("levi's")).toBe(true);
  });

  it('maps an exact single-word keyword', () => {
    const flagged = attributeHitsToTerms(['nike'], [match({ matched_text: 'nike' })]);
    expect(flagged.has('nike')).toBe(true);
  });

  it('does NOT over-attribute a hit to an unrelated prefix sibling in the same chunk', () => {
    // "cat" is the real hit; "caterpillar" merely shares the prefix and must not
    // be flagged when the precise mapping already found the owning term.
    const flagged = attributeHitsToTerms(
      ['cat', 'caterpillar'],
      [match({ wordmark: 'CAT', matched_text: 'cat', owner: 'Caterpillar Inc.' })]
    );
    expect(flagged.has('cat')).toBe(true);
    expect(flagged.has('caterpillar')).toBe(false);
  });
});

describe('chunkFieldText — split long fields, overlap boundaries (regression: candidate overflow)', () => {
  it('returns [] for empty or whitespace-only content', () => {
    expect(chunkFieldText('', 80)).toEqual([]);
    expect(chunkFieldText('   \n ', 80)).toEqual([]);
  });

  it('returns the text unchanged when it already fits the word budget', () => {
    expect(chunkFieldText('nike air max sneakers', 80)).toEqual(['nike air max sneakers']);
  });

  it('splits a long field into chunks that each stay within the word budget', () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkFieldText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.split(' ').length).toBeLessThanOrEqual(80);
    }
    // No silent gaps — every word is covered by at least one chunk.
    const covered = new Set(chunks.flatMap((c) => c.split(' ')));
    for (let i = 0; i < 300; i++) expect(covered.has(`word${i}`)).toBe(true);
  });

  it('keeps a 12-word span across a chunk boundary contiguous (no false clear)', () => {
    // The overlap must guarantee any mark up to MAX_MARK_WORDS words that
    // straddles a boundary still appears whole in some chunk.
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkFieldText(text, 80);
    const boundaryMark = Array.from({ length: 12 }, (_, i) => `w${69 + i}`).join(' ');
    expect(chunks.some((c) => c.includes(boundaryMark))).toBe(true);
  });
});

describe('rebuildListing — clamp rewrite output to field limits (regression: over-limit ship)', () => {
  const baseMeta = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    configUsed: DEFAULT_LISTING_CONFIG,
    totalCertifiedUsed: 0,
    totalFillerUsed: 0,
    validationStats: { totalCandidates: 0, totalChecks: 0, certifiedCount: 0, notFoundCount: 0 },
  };

  it('truncates a rewritten field that exceeds its maxChars', () => {
    const config = {
      ...DEFAULT_LISTING_CONFIG,
      fields: [{ id: 'bullet-1', name: 'Bullet Point Description', maxChars: 40 }],
    };
    const overLimit = 'Playful whiskered feline companion lounge lover original artwork design';
    const rebuilt = rebuildListing({ 'bullet-1': overLimit }, config, [], baseMeta);
    expect(rebuilt.fields[0].content.length).toBeLessThanOrEqual(40);
    // charCount must reflect the clamped content, not the raw AI output.
    expect(rebuilt.fields[0].charCount).toBe(rebuilt.fields[0].content.length);
  });

  it('leaves within-limit content unchanged', () => {
    const config = {
      ...DEFAULT_LISTING_CONFIG,
      fields: [{ id: 'title', name: 'Title', maxChars: 60 }],
    };
    const rebuilt = rebuildListing({ title: 'Cat Mom Vibes' }, config, [], baseMeta);
    expect(rebuilt.fields[0].content).toBe('Cat Mom Vibes');
  });
});
