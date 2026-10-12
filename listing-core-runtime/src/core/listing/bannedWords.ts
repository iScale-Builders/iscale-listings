// Banned words: the one list every step of listing generation enforces — the
// first draft, max-fill padding, the trademark rewrite and the keyword list.
// Trademarks the user bans from a result ("never use this") go on the same list
// and keep their mark details in `config.bannedTrademarks`, so the settings can
// show why each one is there and remove it later (marks get abandoned/cancelled).

import type { BannedTrademark, ListingConfig } from '../types';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary pattern for a banned word or phrase ("cat mom" also matches "cat-mom"). */
function bannedPattern(word: string, flags: string): RegExp | null {
  const parts = word.trim().split(/[\s-]+/).filter(Boolean).map(escapeRegex);
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s-]+')}(?![\\p{L}\\p{N}])`, `${flags}u`);
}

export function hasBannedWord(text: string, bannedWords: readonly string[]): boolean {
  return bannedWords.some((w) => bannedPattern(w, 'i')?.test(text) ?? false);
}

/** Remove every banned word/phrase from `text`, tidying the spaces/punctuation left behind. */
export function stripBannedWords(text: string, bannedWords: readonly string[]): string {
  let out = text;
  for (const w of bannedWords) {
    const re = bannedPattern(w, 'gi');
    if (re) out = out.replace(re, '');
  }
  return out
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,;:])(\s*[,;:])+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
}

/** The term to ban for a trademark hit: what actually appeared in our text. */
export function banTermFor(match: { matched_text?: string; wordmark: string }): string {
  return (match.matched_text || match.wordmark).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Add a trademark (or any word) to the banned list. Returns a new config. */
export function banTrademark(
  config: ListingConfig,
  mark: Omit<BannedTrademark, 'addedAt'> & { addedAt?: string }
): ListingConfig {
  const term = mark.term.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!term) return config;
  const forbiddenWords = config.forbiddenWords.some((w) => w.trim().toLowerCase() === term)
    ? config.forbiddenWords
    : [...config.forbiddenWords, term];
  const bannedTrademarks = [
    ...(config.bannedTrademarks ?? []).filter((b) => b.term !== term),
    { ...mark, term, addedAt: mark.addedAt ?? new Date().toISOString() },
  ];
  return { ...config, forbiddenWords, bannedTrademarks };
}

/** Remove a word from the banned list (and its trademark record, if any). */
export function unbanWord(config: ListingConfig, word: string): ListingConfig {
  const term = word.trim().toLowerCase().replace(/\s+/g, ' ');
  return {
    ...config,
    forbiddenWords: config.forbiddenWords.filter((w) => w.trim().toLowerCase() !== term),
    bannedTrademarks: (config.bannedTrademarks ?? []).filter((b) => b.term !== term),
  };
}
