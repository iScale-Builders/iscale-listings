import { MAX_CANDIDATES, MAX_NGRAM_WORDS } from './constants';

/**
 * Generate n-gram candidates from normalized text.
 *
 * Rules:
 * - Generate contiguous phrases through MAX_NGRAM_WORDS
 * - Skip 1- and 2-letter words as STANDALONE candidates, but keep them inside
 *   multi-word phrases (so a mark like "X GAMES" or "L L BEAN" is still built)
 * - De-pluralize words > 3 chars (strip trailing "s")
 * - Cap the complete request at MAX_CANDIDATES; throw if exceeded
 *
 * Returns the candidate set and whether at least one word >= 3 chars exists.
 */
/**
 * Add de-pluralized singular forms of a single word as extra search
 * candidates. Handles regular -s (cats -> cat), sibilant -es (boxes -> box),
 * and -ies (babies -> baby). Purely additive — it only widens the candidate
 * set, so it can add matches but never cause a false "clear".
 */
function addSingularForms(word: string, set: Set<string>): void {
  if (word.length <= 3) return;
  if (word.endsWith('ies') && word.length > 4) {
    set.add(`${word.slice(0, -3)}y`);
  } else if (
    word.endsWith('es') &&
    word.length > 4 &&
    /(?:s|x|z|ch|sh)$/.test(word.slice(0, -2))
  ) {
    set.add(word.slice(0, -2));
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    set.add(word.slice(0, -1));
  }
}

export function generateCandidates(normalized: string): {
  candidates: string[];
  hasValidWord: boolean;
} {
  // Keep ALL words (including 1- and 2-letter) so multi-word marks that contain
  // a short token — "X GAMES", "L L BEAN", "3 M" — are assembled as phrase
  // candidates. Short tokens are still excluded as STANDALONE candidates below.
  const words = normalized.split(' ').filter(Boolean);
  const hasValidWord = words.some((w) => w.length >= 3);

  const candidateSet = new Set<string>();

  for (let n = 1; n <= MAX_NGRAM_WORDS; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const phrase = words.slice(i, i + n).join(' ');

      // Skip standalone 1- and 2-letter words (kept only inside phrases above).
      if (n === 1 && words[i].length <= 2) continue;

      candidateSet.add(phrase);

      // De-pluralize single words so a plural query still matches a singular
      // mark (query-only and purely additive).
      if (n === 1) {
        addSingularForms(phrase, candidateSet);
      }
    }
  }

  if (candidateSet.size > MAX_CANDIDATES) {
    throw new CandidateOverflowError(candidateSet.size);
  }

  return {
    candidates: Array.from(candidateSet),
    hasValidWord,
  };
}

export class CandidateOverflowError extends Error {
  public readonly candidateCount: number;

  constructor(count: number) {
    super(
      `Input generates ${count} candidates, exceeding the ${MAX_CANDIDATES} limit. Try checking a shorter section of text.`
    );
    this.name = 'CandidateOverflowError';
    this.candidateCount = count;
  }
}
