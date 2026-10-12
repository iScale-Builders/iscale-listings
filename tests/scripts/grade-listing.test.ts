import { describe, it, expect } from 'vitest';
import { gradeListing } from '../../scripts/grade-listing.mjs';

describe('grade-listing', () => {
  const field = (id: string, name: string, content: string, maxChars: number) => ({ id, name, content, maxChars });

  it('flags short fields, a Brand that copies the Title, overused words and trademark removals', () => {
    const g = gradeListing({
      fields: [
        field('title', 'Title', 'Halloween Ghost Funny Boo-tiful Pumpkin Pride', 60),
        field('brand', 'Brand', 'Pumpkin Halloween Candy Patch Funny Ghost', 50),
        field('bullet-1', 'Bullet Point Description', 'halloween ghost halloween fun halloween party', 256),
      ],
      keywords: ['boo-tiful', 'funny ghost', 'trick or treat'],
      trademark: { status: 'clear', changes: [{ original: 'pumpkin spice', replacement: 'pumpkin pride' }] },
    });
    const fail = g.checks.filter((c) => !c.pass).map((c) => c.check);
    expect(fail).toContain('Title length');
    expect(fail).toContain('Brand uses different words than Title');
    expect(fail).toContain('Other fields do not overuse words');
    expect(g.keywordsUsed).toBe('2 of 3 offered'); // boo-tiful + funny ghost (in the Brand)
    expect(g.removedByTrademarkCheck).toEqual(['pumpkin spice']);
  });

  it('passes a full, varied listing', () => {
    const g = gradeListing({
      fields: [
        field('title', 'Title', 'Boo-tiful Halloween Ghost Candy Corn Pride Funny Spooky Art', 60),
        field('brand', 'Brand', 'Witchy Moonlit Forest Bats Trick Treat Studio', 50),
        field('bullet-1', 'Bullet Point Description', 'x'.repeat(230), 256),
      ],
      keywords: [],
      trademark: { status: 'clear', changes: [] },
    });
    expect(g.checks.every((c) => c.pass)).toBe(true);
  });
});
