import { describe, expect, it } from 'vitest';
import {
  ALL_POD,
  CATEGORIES,
  categoryForClass,
  isPodClass,
  categoryTabLabel,
  highlightBackground,
  normalizeClass,
  sameClasses,
  splitGradient,
  tint,
  trademarkStatusTone,
  typeOfClass,
} from '../../extension/categories';
import {
  DEFAULT_STATUS_VISIBILITY,
  normalizeStatusVisibility,
  safeHttpUrl,
} from '../../extension/shared';

describe('category tabs', () => {
  it('has one tab per POD class (25, 09, 16, 18, 20, 21, 24) with the code in front', () => {
    expect(CATEGORIES.map(categoryTabLabel)).toEqual([
      '25 - Apparel',
      '09 - Phone Cases',
      '16 - Paper / Stickers',
      '18 - Bags',
      '20 - Home Decor',
      '21 - Drinkware',
      '24 - Blankets',
    ]);
    expect(CATEGORIES.flatMap((c) => c.classes).sort()).toEqual([...ALL_POD.classes].sort());
    expect(new Set(CATEGORIES.map((c) => c.color)).size).toBe(CATEGORIES.length);
    expect(categoryTabLabel(ALL_POD)).toBe('All POD');
  });
});

describe('normalizeClass', () => {
  it('pads and extracts digits from common IC formats', () => {
    expect(normalizeClass('025')).toBe('025');
    expect(normalizeClass('25')).toBe('025');
    expect(normalizeClass('IC 025')).toBe('025');
    expect(normalizeClass('Class 9')).toBe('009');
    expect(normalizeClass('9')).toBe('009');
  });

  it('keeps only the last three digits of over-long digit strings', () => {
    expect(normalizeClass('9025')).toBe('025');
  });

  it('returns empty for missing or digit-free input', () => {
    expect(normalizeClass(null)).toBe('');
    expect(normalizeClass(undefined)).toBe('');
    expect(normalizeClass('')).toBe('');
    expect(normalizeClass('abc')).toBe('');
  });
});

describe('categoryForClass / typeOfClass', () => {
  it('maps every declared class to its real category (not the All POD meta-tab)', () => {
    for (const cat of CATEGORIES) {
      for (const cls of cat.classes) {
        expect(categoryForClass(cls)?.label).toBe(cat.label);
      }
    }
  });

  it('All POD shares the union of real classes but never wins a lookup', () => {
    expect(new Set(ALL_POD.classes)).toEqual(
      new Set(CATEGORIES.flatMap((c) => c.classes))
    );
    for (const cls of ALL_POD.classes) {
      expect(categoryForClass(cls)?.label).not.toBe('All POD');
    }
  });

  it('normalizes before lookup so "IC 9" finds Phone Cases', () => {
    expect(categoryForClass('IC 9')?.label).toBe('Phone Cases');
  });

  it('has no Other bucket: unmapped classes are not a POD type', () => {
    expect(categoryForClass('999')).toBeUndefined();
    expect(typeOfClass('999')).toBeNull();
    expect(typeOfClass(null)).toBeNull();
    expect(isPodClass('999')).toBe(false);
    expect(isPodClass('IC 25')).toBe(true);
  });

  it('returns the category label and color for mapped classes', () => {
    expect(typeOfClass('025')).toEqual({ label: 'Apparel', color: '#39ff14' });
    expect(typeOfClass('018')).toEqual({ label: 'Bags', color: '#bc13fe' });
  });
});

describe('sameClasses', () => {
  it('compares normalized, order-insensitive', () => {
    expect(sameClasses(['25'], ['025'])).toBe(true);
    expect(sameClasses(['025', '009'], ['009', '025'])).toBe(true);
  });

  it('rejects different lengths and subsets', () => {
    expect(sameClasses(['025'], ['025', '009'])).toBe(false);
    expect(sameClasses(['025', '009'], ['025', '018'])).toBe(false);
  });
});

describe('tint', () => {
  it('produces an rgba string from hex + alpha', () => {
    expect(tint('#22c55e', 0.32)).toBe('rgba(34, 197, 94, 0.32)');
    expect(tint('#ff0000', 1)).toBe('rgba(255, 0, 0, 1)');
  });
});

describe('trademarkStatusTone edge cases', () => {
  it('returns pending (never unknown) when nothing is provided', () => {
    expect(trademarkStatusTone(null, null)).toBe('pending');
    expect(trademarkStatusTone(undefined, undefined)).toBe('pending');
  });

  it('dead beats a registered lifecycle when the record itself says dead', () => {
    expect(trademarkStatusTone('registered', 'dead')).toBe('dead');
    expect(trademarkStatusTone('cancelled', 'live')).toBe('dead');
  });

  it('pending is checked before dead so pending stays pending', () => {
    expect(trademarkStatusTone('pending', 'dead')).toBe('pending');
  });
});

describe('highlightBackground / splitGradient', () => {
  it('paints nothing with no colors', () => {
    expect(highlightBackground([], 0.3)).toBe('transparent');
  });

  it('transparent passes through tint untouched', () => {
    expect(tint('transparent', 0.5)).toBe('transparent');
  });

  it('one color is a flat tint; two or more become a hard split gradient', () => {
    expect(highlightBackground(['#ff0000'], 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    const multi = highlightBackground(['#ff0000', '#00ff00'], 0.5);
    expect(multi).toContain('linear-gradient(to right');
    expect(multi).toContain('rgba(255, 0, 0, 0.5)');
    expect(multi).toContain('rgba(0, 255, 0, 0.5)');
  });

  it('splitGradient always emits an image, even for a single color', () => {
    expect(splitGradient(['#ff0000'], 0.5)).toBe(
      'linear-gradient(rgba(255, 0, 0, 0.5), rgba(255, 0, 0, 0.5))'
    );
    expect(splitGradient([], 0.5)).toContain('linear-gradient(');
    expect(splitGradient(['#ff0000', '#00ff00'], 0.5)).toContain('to right');
  });
});

describe('normalizeStatusVisibility', () => {
  it('defaults everything visible for missing or malformed input', () => {
    expect(normalizeStatusVisibility(null)).toEqual(DEFAULT_STATUS_VISIBILITY);
    expect(normalizeStatusVisibility(undefined)).toEqual(DEFAULT_STATUS_VISIBILITY);
    expect(normalizeStatusVisibility('nope')).toEqual(DEFAULT_STATUS_VISIBILITY);
    expect(normalizeStatusVisibility(42)).toEqual(DEFAULT_STATUS_VISIBILITY);
  });

  it('preserves explicit false values and defaults missing keys', () => {
    expect(normalizeStatusVisibility({ live: false })).toEqual({
      live: false,
      pending: true,
      dead: true,
    });
    // A user who turned every filter off must not get them back on restart.
    expect(
      normalizeStatusVisibility({ live: false, pending: false, dead: false, unknown: false })
    ).toEqual({ live: false, pending: false, dead: false });
  });

  it('does not mutate the defaults object', () => {
    const before = { ...DEFAULT_STATUS_VISIBILITY };
    normalizeStatusVisibility({ live: false });
    expect(DEFAULT_STATUS_VISIBILITY).toEqual(before);
  });
});

describe('safeHttpUrl', () => {
  it('passes http and https URLs through', () => {
    expect(safeHttpUrl('https://tsdr.uspto.gov/#caseNumber=1')).toBe(
      'https://tsdr.uspto.gov/#caseNumber=1'
    );
    expect(safeHttpUrl('http://example.com/x')).toBe('http://example.com/x');
  });

  it('rejects javascript:, data:, and other non-http schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeHttpUrl('chrome://extensions')).toBe('');
    expect(safeHttpUrl('file:///etc/passwd')).toBe('');
  });

  it('rejects malformed and empty input', () => {
    expect(safeHttpUrl('not a url')).toBe('');
    expect(safeHttpUrl('')).toBe('');
    expect(safeHttpUrl(null)).toBe('');
    expect(safeHttpUrl(undefined)).toBe('');
  });
});
