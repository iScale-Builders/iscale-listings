import { describe, it, expect } from 'vitest';
import {
  ALL_FORBIDDEN_WORDS,
  FORBIDDEN_PRODUCT_WORDS,
  FORBIDDEN_MATERIAL_WORDS,
  FORBIDDEN_GIFT_WORDS,
  DEFAULT_LISTING_CONFIG,
  TRADEMARK_CLASSES,
  MODE_INSTRUCTIONS,
} from './index';

describe('ALL_FORBIDDEN_WORDS', () => {
  it('includes product words', () => {
    for (const w of FORBIDDEN_PRODUCT_WORDS) {
      expect(ALL_FORBIDDEN_WORDS).toContain(w);
    }
  });

  it('includes material words', () => {
    for (const w of FORBIDDEN_MATERIAL_WORDS) {
      expect(ALL_FORBIDDEN_WORDS).toContain(w);
    }
  });

  it('includes gift words', () => {
    for (const w of FORBIDDEN_GIFT_WORDS) {
      expect(ALL_FORBIDDEN_WORDS).toContain(w);
    }
  });

  it('contains "shirt" and "tshirt"', () => {
    expect(ALL_FORBIDDEN_WORDS).toContain('shirt');
    expect(ALL_FORBIDDEN_WORDS).toContain('tshirt');
    expect(ALL_FORBIDDEN_WORDS).toContain('t-shirt');
  });

  it('contains "gift"', () => {
    expect(ALL_FORBIDDEN_WORDS).toContain('gift');
  });
});

describe('DEFAULT_LISTING_CONFIG', () => {
  it('has expected fields', () => {
    const ids = DEFAULT_LISTING_CONFIG.fields.map((f) => f.id);
    expect(ids).toContain('title');
    expect(ids).toContain('brand');
    expect(ids).toContain('bullet-1');
    expect(ids).toContain('bullet-2');
  });

  it('has title max 60 chars', () => {
    const title = DEFAULT_LISTING_CONFIG.fields.find((f) => f.id === 'title');
    expect(title?.maxChars).toBe(60);
  });

  it('includes apparel class 025 in trademarkClasses', () => {
    expect(DEFAULT_LISTING_CONFIG.trademarkClasses).toContain('025');
  });

  it('has product variants including shirt forms', () => {
    const variants = DEFAULT_LISTING_CONFIG.productVariants;
    expect(variants).toContain('shirt');
    expect(variants).toContain('tshirt');
    expect(variants).toContain('t-shirt');
  });
});

describe('TRADEMARK_CLASSES', () => {
  it('includes apparel class 025', () => {
    const apparel = TRADEMARK_CLASSES.find((c) => c.code === '025');
    expect(apparel).toBeDefined();
    expect(apparel?.label).toBe('Apparel');
  });

  it('all classes have required fields', () => {
    for (const cls of TRADEMARK_CLASSES) {
      expect(cls.code).toBeTruthy();
      expect(cls.label).toBeTruthy();
      expect(cls.color).toBeTruthy();
      expect(cls.colorLight).toBeTruthy();
    }
  });
});

describe('MODE_INSTRUCTIONS', () => {
  it('has balanced, natural, aggressive modes', () => {
    expect(MODE_INSTRUCTIONS.balanced).toBeTruthy();
    expect(MODE_INSTRUCTIONS.natural).toBeTruthy();
    expect(MODE_INSTRUCTIONS.aggressive).toBeTruthy();
  });

  it('aggressive mode mentions keyword density', () => {
    expect(MODE_INSTRUCTIONS.aggressive.toLowerCase()).toContain('keyword');
  });
});
