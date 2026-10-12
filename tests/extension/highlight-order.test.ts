import { describe, expect, it } from 'vitest';

describe('highlight group order', () => {
  it('paints longer matched_text first so short marks cannot split phrases', () => {
    const groups = new Map<string, string[]>([
      ['girl', ['girl']],
      ['just a girl who loves', ['just a girl who loves']],
    ]);

    const ordered = [...groups.entries()].sort((a, b) => b[0].length - a[0].length);

    expect(ordered.map(([key]) => key)).toEqual(['just a girl who loves', 'girl']);
    expect(ordered[0][0].length).toBeGreaterThanOrEqual(
      Math.max(...ordered.slice(1).map(([key]) => key.length))
    );
  });
});
