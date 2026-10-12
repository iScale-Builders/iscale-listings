import { describe, it, expect } from 'vitest';
import { generateCandidates, CandidateOverflowError } from '@/lib/trademark/ngrams';

describe('generateCandidates', () => {
  it('generates 1-gram candidates', () => {
    const { candidates } = generateCandidates('cat dad funny');
    expect(candidates).toContain('cat');
    expect(candidates).toContain('dad');
    expect(candidates).toContain('funny');
  });

  it('generates multi-word n-grams up to 12 words', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const { candidates } = generateCandidates(text);
    expect(candidates).toContain('one two');
    expect(candidates).toContain('one two three four five');
    expect(candidates).toContain('one two three four five six seven eight nine ten eleven twelve');
    expect(candidates).not.toContain(text);
  });

  it('skips 1-letter words entirely', () => {
    const { candidates } = generateCandidates('a cat');
    // "a" is 1-letter, filtered out from word list
    // only "cat" remains as a standalone word
    expect(candidates).not.toContain('a');
  });

  it('skips standalone 2-letter words', () => {
    const { candidates } = generateCandidates('to be or not');
    expect(candidates).not.toContain('to');
    expect(candidates).not.toContain('be');
    expect(candidates).not.toContain('or');
    expect(candidates).toContain('not');
  });

  it('includes 2-letter words in multi-word phrases', () => {
    const { candidates } = generateCandidates('out of office');
    expect(candidates).toContain('out of office');
    expect(candidates).toContain('out of');
    expect(candidates).toContain('of office');
  });

  it('includes 1-letter words in multi-word phrases (regression: X GAMES unmatchable)', () => {
    // "X GAMES", "L L BEAN", "3 M" contain a 1-letter token; dropping it from
    // the word list made the mark's phrase impossible to generate → false clear.
    const { candidates } = generateCandidates('x games hoodie');
    expect(candidates).toContain('x games');
    expect(candidates).toContain('x games hoodie');
    // ...but the 1-letter word is still not a standalone candidate.
    expect(candidates).not.toContain('x');
  });

  it('de-pluralizes words > 3 chars', () => {
    const { candidates } = generateCandidates('cats dogs');
    expect(candidates).toContain('cats');
    expect(candidates).toContain('cat');
    expect(candidates).toContain('dogs');
    expect(candidates).toContain('dog');
  });

  it('de-pluralizes sibilant -es and -ies forms', () => {
    const { candidates } = generateCandidates('boxes babies dishes');
    expect(candidates).toContain('box');
    expect(candidates).toContain('baby');
    expect(candidates).toContain('dish');
  });

  it('does not de-pluralize words <= 3 chars', () => {
    const { candidates } = generateCandidates('bus');
    expect(candidates).toContain('bus');
    expect(candidates).not.toContain('bu');
  });

  it('reports hasValidWord correctly when valid words exist', () => {
    const { hasValidWord } = generateCandidates('cat dad');
    expect(hasValidWord).toBe(true);
  });

  it('reports hasValidWord false when only 2-letter words', () => {
    const { hasValidWord } = generateCandidates('to be or');
    expect(hasValidWord).toBe(false);
  });

  it('handles empty string', () => {
    const { candidates, hasValidWord } = generateCandidates('');
    expect(candidates).toHaveLength(0);
    expect(hasValidWord).toBe(false);
  });

  it('throws CandidateOverflowError when exceeding the full-request candidate cap', () => {
    const words = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
    expect(() => generateCandidates(words)).toThrow(CandidateOverflowError);
  });
});
