import { describe, it, expect, vi } from 'vitest';
import { normalizeText } from '@/lib/trademark/normalize';
import { generateCandidates, CandidateOverflowError } from '@/lib/trademark/ngrams';
import { classifyConfidence } from '@/lib/trademark/confidence';
import { matchTrademarks } from '@/lib/trademark/matcher';
import { MAX_CANDIDATES, MAX_RESULTS, MAX_RPC_CANDIDATES } from '@/lib/trademark/constants';

describe('matching pipeline', () => {
  it('normalize -> ngrams -> confidence works end-to-end', () => {
    const input = "Vintage Cat Dad's Funny Gift T-Shirt";
    const normalized = normalizeText(input);
    expect(normalized).toBe('vintage cat dads funny gift t shirt');

    const { candidates, hasValidWord } = generateCandidates(normalized);
    expect(hasValidWord).toBe(true);
    expect(candidates).toContain('vintage');
    expect(candidates).toContain('cat');
    expect(candidates).toContain('cat dads');
    expect(candidates).toContain('funny gift');

    // De-pluralization
    expect(candidates).toContain('dad');

    // Confidence
    expect(classifyConfidence('cat')).toBe('low');
    expect(classifyConfidence('cat dad')).toBe('high');
    expect(classifyConfidence('vintage')).toBe('high');
  });

  it('candidate overflow for very long text', () => {
    const words = Array.from({ length: 180 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    expect(() => generateCandidates(text)).toThrow(CandidateOverflowError);
  });

  it('handles text with only short words', () => {
    const normalized = normalizeText('to be or');
    const { hasValidWord } = generateCandidates(normalized);
    expect(hasValidWord).toBe(false);
  });

  it('handles text with hyphens and apostrophes', () => {
    const normalized = normalizeText("World's Best T-Shirt");
    expect(normalized).toBe('worlds best t shirt');
    const { candidates } = generateCandidates(normalized);
    expect(candidates).toContain('worlds best');
    expect(candidates).toContain('best');
  });

});

describe('matchTrademarks (orchestrator)', () => {
  const baseRow = {
    jurisdiction: 'US',
    wordmark: 'X',
    wordmark_normalized: 'x',
    serial_number: '1',
    registration_number: '123',
    international_class: '025',
    owner_name: 'Owner',
    status: 'LIVE',
    status_code: '',
    filing_date: null,
  };
  // Minimal SupabaseClient stub: matchTrademarks only calls `.rpc()`.
  const rpcReturning = (rows: unknown[] | null, error: unknown = null) =>
    ({ rpc: vi.fn().mockResolvedValue({ data: rows, error }) }) as never;

  it('derives registration_status from status + registration number', () => {
    return matchTrademarks(
      'alpha bravo charlie',
      ['025'],
      rpcReturning([
        { ...baseRow, wordmark: 'A', wordmark_normalized: 'a', status: 'LIVE', registration_number: '100' },
        { ...baseRow, wordmark: 'B', wordmark_normalized: 'b', status: 'LIVE', registration_number: null },
        { ...baseRow, wordmark: 'C', wordmark_normalized: 'c', status: 'DEAD', registration_number: '200' },
        { ...baseRow, wordmark: 'D', wordmark_normalized: 'd', status: 'DEAD', registration_number: null },
        { ...baseRow, wordmark: 'E', wordmark_normalized: 'e', status: 'LIVE', registration_number: '000000' },
      ])
    ).then((res) => {
      const byMark = Object.fromEntries(res.matches.map((m) => [m.wordmark, m.registration_status]));
      // all-zeros registration number is a placeholder -> pending, not registered
      expect(byMark).toEqual({ A: 'registered', B: 'pending', C: 'cancelled', D: 'abandoned', E: 'pending' });
    });
  });

  it('danger-rank sort keeps an enforceable registered mark above the 50-cap', async () => {
    // 55 weaker LIVE *pending* marks whose wordmarks sort alphabetically BEFORE
    // the one registered mark. Without the registration tier in the sort, the
    // registered 'ZZZ' lands at index 55 and gets truncated by MAX_RESULTS — a
    // real safety miss (an enforceable mark silently dropped). It must survive.
    const pending = Array.from({ length: 55 }, (_, i) => ({
      ...baseRow,
      wordmark: `AAA${String(i).padStart(3, '0')}`,
      wordmark_normalized: `aaa${i}`,
      status: 'LIVE',
      registration_number: null,
    }));
    const registered = {
      ...baseRow, wordmark: 'ZZZ', wordmark_normalized: 'zzz', status: 'LIVE', registration_number: '999999',
    };

    const res = await matchTrademarks('alpha bravo charlie', ['025'], rpcReturning([...pending, registered]));

    expect(res.totalMatches).toBe(56);
    expect(res.truncated).toBe(true);
    expect(res.matches).toHaveLength(MAX_RESULTS);
    expect(res.matches[0].wordmark).toBe('ZZZ');
    expect(res.matches.some((m) => m.wordmark === 'ZZZ')).toBe(true);
  });

  it('sorts LIVE before DEAD even when the DEAD mark is registered', async () => {
    const res = await matchTrademarks(
      'alpha bravo charlie',
      ['025'],
      rpcReturning([
        { ...baseRow, wordmark: 'DEADREG', wordmark_normalized: 'deadreg', status: 'DEAD', registration_number: '111' },
        { ...baseRow, wordmark: 'LIVEPEND', wordmark_normalized: 'livepend', status: 'LIVE', registration_number: null },
      ])
    );
    expect(res.matches[0].status).toBe('LIVE');
  });

  it('throws (fail loud) when the RPC returns an error — never a silent empty clear', async () => {
    await expect(
      matchTrademarks('alpha bravo charlie', ['025'], rpcReturning(null, { code: 'PGRST500', message: 'boom' }))
    ).rejects.toBeDefined();
  });

  it('batches large candidate sets and preserves a 12-word exact mark', async () => {
    const longMark = 'one two three four five six seven eight nine ten eleven twelve';
    const text = `${longMark} ${Array.from({ length: 68 }, (_, i) => `filler${i}`).join(' ')}`;
    const rpc = vi.fn(async (_name: string, args: { candidate_list: string[] }) => ({
      data: args.candidate_list.includes(longMark)
        ? [{ ...baseRow, wordmark: longMark.toUpperCase(), wordmark_normalized: longMark }]
        : [],
      error: null,
    }));

    const result = await matchTrademarks(text, ['025'], { rpc } as never, false, ['US', 'EUIPO']);

    expect(rpc.mock.calls.length).toBeGreaterThan(1);
    for (const [, args] of rpc.mock.calls) {
      expect(args.candidate_list.length).toBeLessThanOrEqual(MAX_RPC_CANDIDATES);
    }
    expect(result.candidates).toContain(longMark);
    expect(result.matches.map((match) => match.wordmark)).toContain(longMark.toUpperCase());
  });
});
