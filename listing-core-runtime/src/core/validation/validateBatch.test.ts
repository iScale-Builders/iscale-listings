import { describe, it, expect, vi } from 'vitest';
import { validateKeyword, validateBatch } from './validateBatch';
import type { CandidateKeyword } from '../types';

function makeCandidate(
  word: string,
  source: CandidateKeyword['source'] = 'visual'
): CandidateKeyword {
  return {
    id: word,
    word,
    source,
    isPhrase: word.includes(' '),
  };
}

describe('validateKeyword', () => {
  it('certifies a keyword found in suggestions', async () => {
    const fetcher = vi.fn().mockResolvedValue(['cat shirt', 'cat tshirt', 'funny cat']);
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt']);
    expect(result).toHaveLength(1);
    expect(result[0].certified).toBe(true);
    expect(result[0].bestPosition).toBe(1);
  });

  it('certifies when a suggestion repeats a product word (adjacent-duplicate variant)', async () => {
    // Regression: "cat shirt shirt" left a stray "shirt" after variant-stripping
    // (shared delimiter space consumed), wrongly marking "cat" uncertified.
    const fetcher = vi.fn().mockResolvedValue(['cat shirt shirt']);
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt']);
    expect(result[0].certified).toBe(true);
  });

  it('marks keyword as not certified when not in suggestions', async () => {
    const fetcher = vi.fn().mockResolvedValue(['dog shirt', 'puppy shirt']);
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt']);
    expect(result[0].certified).toBe(false);
    expect(result[0].bestPosition).toBeNull();
  });

  it('checks multiple product variants', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([]) // shirt - not found
      .mockResolvedValueOnce(['cat tshirt']); // tshirt - found
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt', 'tshirt']);
    expect(result[0].certified).toBe(true);
    expect(result[0].bestVariant).toBe('tshirt');
  });

  it('splits phrase into words when phrase not found', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([]) // "coffee lover shirt" - not found
      .mockResolvedValueOnce(['coffee shirt']) // "coffee shirt" - found
      .mockResolvedValueOnce([]); // "lover shirt" - not found
    const result = await validateKeyword(makeCandidate('coffee lover'), fetcher, ['shirt']);
    // Should return individual words since phrase wasn't found
    const words = result.map((r) => r.word);
    expect(words).toContain('coffee');
    expect(words).toContain('lover');
  });

  it('keeps phrase intact when found in suggestions', async () => {
    const fetcher = vi.fn().mockResolvedValue(['coffee lover shirt', 'coffee lover tee']);
    const result = await validateKeyword(makeCandidate('coffee lover'), fetcher, ['shirt']);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe('coffee lover');
    expect(result[0].certified).toBe(true);
  });

  it('uses word boundary matching — does not match substrings', async () => {
    // "cat" should not match "concatenate"
    const fetcher = vi.fn().mockResolvedValue(['concatenate shirt']);
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt']);
    expect(result[0].certified).toBe(false);
  });

  it('handles fetcher errors gracefully', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await validateKeyword(makeCandidate('cat'), fetcher, ['shirt']);
    expect(result[0].certified).toBe(false);
  });
});

describe('validateBatch', () => {
  it('validates all candidates and returns results', async () => {
    const fetcher = vi.fn().mockResolvedValue(['cat shirt', 'dog shirt']);
    const candidates = [makeCandidate('cat'), makeCandidate('dog')];
    const results = await validateBatch(candidates, fetcher, ['shirt']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.certified)).toBe(true);
  });

  it('deduplicates results', async () => {
    // "cat dog" phrase will split into "cat" and "dog", but we also have standalone "cat"
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([]) // "cat dog shirt" - not found
      .mockResolvedValueOnce(['cat shirt']) // "cat shirt" - found
      .mockResolvedValueOnce([]) // "dog shirt" - not found
      .mockResolvedValueOnce(['cat shirt']); // standalone "cat shirt" - found
    const candidates = [makeCandidate('cat dog'), makeCandidate('cat')];
    const results = await validateBatch(candidates, fetcher, ['shirt']);
    // Should deduplicate "cat"
    const catResults = results.filter((r) => r.word === 'cat');
    expect(catResults).toHaveLength(1);
  });

  it('reports progress', async () => {
    const fetcher = vi.fn().mockResolvedValue(['cat shirt']);
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate(`word${i}`));
    const progressValues: number[] = [];
    await validateBatch(candidates, fetcher, ['shirt'], {
      concurrency: 2,
      onProgress: (p) => progressValues.push(p),
    });
    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });
});
