import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTING_CONFIG } from '../types';
import { banTermFor, banTrademark, hasBannedWord, stripBannedWords, unbanWord } from './bannedWords';
import { rebuildListing } from './trademarkCheck';

describe('banned words', () => {
  it('matches whole words and phrases (also across a hyphen), case-insensitive', () => {
    expect(hasBannedWord('Casual Friday Tee', ['casual friday'])).toBe(true);
    expect(hasBannedWord('casual-friday vibes', ['casual friday'])).toBe(true);
    expect(hasBannedWord('casually fridays', ['casual friday'])).toBe(false);
    expect(hasBannedWord('a stylish design', ['style'])).toBe(false);
  });

  it('strips banned words and tidies what is left', () => {
    expect(stripBannedWords('Retro Gift, for Casual Friday fans', ['gift', 'casual friday'])).toBe('Retro, for fans');
  });

  it('bans a trademark hit by the text that matched, keeping the mark details', () => {
    const term = banTermFor({ matched_text: 'Casual  Friday', wordmark: 'CASUAL FRIDAY' });
    expect(term).toBe('casual friday');
    const config = banTrademark(structuredClone(DEFAULT_LISTING_CONFIG), {
      term,
      wordmark: 'CASUAL FRIDAY',
      owner: 'Casual Friday Golf LLC',
      international_class: '025',
      jurisdiction: 'US',
      registration_status: 'pending',
    });
    expect(config.forbiddenWords).toContain('casual friday');
    expect(config.bannedTrademarks?.[0]).toMatchObject({ term: 'casual friday', wordmark: 'CASUAL FRIDAY', jurisdiction: 'US' });
    // Banning twice doesn't duplicate; unbanning removes both.
    const twice = banTrademark(config, { term: 'Casual Friday', wordmark: 'CASUAL FRIDAY' });
    expect(twice.forbiddenWords.filter((w) => w === 'casual friday')).toHaveLength(1);
    expect(twice.bannedTrademarks).toHaveLength(1);
    const un = unbanWord(twice, 'casual friday');
    expect(un.forbiddenWords).not.toContain('casual friday');
    expect(un.bannedTrademarks).toHaveLength(0);
  });

  it('enforces the banned list on the trademark-rewrite output', () => {
    const config = { ...structuredClone(DEFAULT_LISTING_CONFIG), forbiddenWords: ['gift'] };
    const fields = Object.fromEntries(config.fields.map((f) => [f.id, `Funny cat dad gift ${f.name}`]));
    const listing = rebuildListing(fields, config, [], { generatedAt: '', totalKeywordsUsed: 0, totalCertified: 0, totalFiller: 0 } as never);
    for (const f of listing.fields) expect(f.content.toLowerCase()).not.toContain('gift');
  });
});
