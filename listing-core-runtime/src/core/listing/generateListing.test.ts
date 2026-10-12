import { describe, expect, it, vi } from 'vitest';
import { generateListing, clampToMaxChars, listingQualityIssues } from './generateListing';
import { DEFAULT_LISTING_CONFIG, maxKeywordsOf, type ValidatedKeyword } from '../types';
import { chatCompletion } from '@/lib/ai-provider';

vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai-provider')>()),
  chatCompletion: vi.fn(async () =>
    JSON.stringify({
      title:
        'Amazing forbidden shirt phrase that is intentionally far too long for a tiny title field',
      brand: 'Clean Brand',
    })
  ),
}));

const keyword: ValidatedKeyword = {
  id: 'kw-1',
  word: 'amazing',
  source: 'manual',
  isPhrase: false,
  subWords: [],
  validations: [],
  certified: true,
  bestPosition: 1,
  bestVariant: 'shirt',
  selected: true,
};

describe('generateListing', () => {
  it('keeps trying max-fill until fields are within four characters of max', async () => {
    const chat = vi.mocked(chatCompletion);
    chat
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Cat Mom',
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ title: '' }));

    const extraKeywords: ValidatedKeyword[] = [
      keyword,
      {
        ...keyword,
        id: 'kw-2',
        word: 'coffee lover',
        isPhrase: true,
        certified: true,
      },
      {
        ...keyword,
        id: 'kw-3',
        word: 'retro sunset',
        isPhrase: true,
        certified: true,
      },
      {
        ...keyword,
        id: 'kw-4',
        word: 'funny animal',
        isPhrase: true,
        certified: false,
      },
    ];

    const listing = await generateListing({
      qualityPass: false,
      apiKey: 'test-key',
      validatedKeywords: extraKeywords,
      config: {
        ...DEFAULT_LISTING_CONFIG,
        maxFill: true,
        forbiddenWords: [],
        fields: [{ id: 'title', name: 'Title', maxChars: 42 }],
      },
      aiConfig: { provider: 'openai', apiKey: 'test-key' },
    });

    const title = listing.fields.find((field) => field.fieldId === 'title');

    expect(title?.content).toBe('Cat Mom coffee lover retro sunset amazing');
    expect(title?.content).not.toContain(',');
    expect(title?.charCount).toBeGreaterThanOrEqual(38);
    expect(title?.charCount).toBeLessThanOrEqual(42);
  });

  it('deterministically closes max-fill gaps on every configured field', async () => {
    const chat = vi.mocked(chatCompletion);
    chat
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Funny Cat Mom Coffee Mood Monday Sarcastic Cute Animal',
          brand: 'Cat Coffee Mood Apparel',
          'bullet-1':
            'Funny cat mom coffee mood artwork for sarcastic animal lovers who enjoy Monday humor and cozy cafe vibes.',
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ title: '', brand: '', 'bullet-1': '' }));

    const listing = await generateListing({
      qualityPass: false,
      apiKey: 'test-key',
      validatedKeywords: [
        { ...keyword, id: 'kw-2', word: 'cat mom coffee', isPhrase: true },
        { ...keyword, id: 'kw-3', word: 'monday mood', isPhrase: true },
        { ...keyword, id: 'kw-4', word: 'sarcastic animal lover', isPhrase: true },
      ],
      config: {
        ...DEFAULT_LISTING_CONFIG,
        maxFill: true,
        forbiddenWords: [],
        fields: [
          { id: 'title', name: 'Title', maxChars: 80 },
          { id: 'brand', name: 'Brand', maxChars: 50 },
          { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
        ],
      },
      aiConfig: { provider: 'openai', apiKey: 'test-key' },
    });

    for (const field of listing.fields) {
      expect(field.maxChars - field.charCount).toBeLessThanOrEqual(4);
      expect(field.charCount).toBeLessThanOrEqual(field.maxChars);
    }
  });

  it('sanitizes forbidden words and clamps fields to their max character limit', async () => {
    const listing = await generateListing({
      qualityPass: false,
      apiKey: 'test-key',
      validatedKeywords: [keyword],
      config: {
        ...DEFAULT_LISTING_CONFIG,
        forbiddenWords: ['forbidden', 'shirt'],
        fields: [
          { id: 'title', name: 'Title', maxChars: 24 },
          { id: 'brand', name: 'Brand', maxChars: 50 },
        ],
      },
      aiConfig: { provider: 'openai', apiKey: 'test-key' },
    });

    const title = listing.fields.find((field) => field.fieldId === 'title');

    expect(title?.content.toLowerCase()).not.toContain('forbidden');
    expect(title?.content.toLowerCase()).not.toContain('shirt');
    expect(title?.charCount).toBeLessThanOrEqual(24);
  });

  it('removes commas from title and brand fields', async () => {
    const chat = vi.mocked(chatCompletion);
    chat.mockResolvedValueOnce(
      JSON.stringify({
        title: 'Cute Cat Mom, Coffee Lover, Monday Mood',
        brand: 'Cat Mom, Coffee Club',
        'bullet-1': 'Cute cat mom design, coffee lover mood, monday humor.',
      })
    );

    const listing = await generateListing({
      qualityPass: false,
      apiKey: 'test-key',
      validatedKeywords: [keyword],
      config: {
        ...DEFAULT_LISTING_CONFIG,
        forbiddenWords: [],
        fields: [
          { id: 'title', name: 'Title', maxChars: 80 },
          { id: 'brand', name: 'Brand', maxChars: 50 },
          { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
        ],
      },
      aiConfig: { provider: 'openai', apiKey: 'test-key' },
    });

    const title = listing.fields.find((field) => field.fieldId === 'title');
    const brand = listing.fields.find((field) => field.fieldId === 'brand');
    const bullet = listing.fields.find((field) => field.fieldId === 'bullet-1');

    expect(title?.content).toBe('Cute Cat Mom Coffee Lover Monday Mood');
    expect(brand?.content).toBe('Cat Mom Coffee Club');
    expect(bullet?.content).toContain(',');
  });

  it('normalizes all-caps keywords before asking the AI to write listing copy', async () => {
    const chat = vi.mocked(chatCompletion);
    chat.mockResolvedValueOnce(JSON.stringify({ title: 'Funny Cat Dad' }));

    await generateListing({
      qualityPass: false,
      apiKey: 'test-key',
      validatedKeywords: [{ ...keyword, word: 'FUNNY CAT DAD', isPhrase: true }],
      config: {
        ...DEFAULT_LISTING_CONFIG,
        fields: [{ id: 'title', name: 'Title', maxChars: 80 }],
      },
      aiConfig: { provider: 'openai', apiKey: 'test-key' },
    });

    const prompt = chat.mock.calls.at(-1)?.[1] ?? '';
    expect(prompt).toContain('"funny cat dad"');
    expect(prompt).not.toContain('"FUNNY CAT DAD"');
    expect(prompt).toContain('KEYWORD CASING');
    expect(prompt).toContain('NO COMMAS in the Title or Brand');
  });
});

describe('clampToMaxChars', () => {
  it('returns content unchanged when within the limit', () => {
    expect(clampToMaxChars('Cat Mom Vibes', 60)).toBe('Cat Mom Vibes');
  });

  it('does not split a surrogate pair at the cut point (no U+FFFD)', () => {
    // '🎨' is a surrogate pair (2 UTF-16 units). Cutting at maxChars=1 would slice
    // it in half; the clamp must back up and drop the whole emoji instead.
    const out = clampToMaxChars('🎨art', 1);
    expect(out).not.toContain('�');
    expect(out.length).toBeLessThanOrEqual(1);
    // No lone high surrogate left at the end.
    if (out.length) {
      const last = out.charCodeAt(out.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('keeps a whole emoji when it fits within the limit', () => {
    // maxChars=2 fits the 2-unit pair exactly.
    expect(clampToMaxChars('🎨art', 2)).toBe('🎨');
  });
});

describe('keywords handed to the AI', () => {
  it('uses 30 by default and treats an old stored 10 as the default', () => {
    expect(maxKeywordsOf({ maxKeywords: 10 })).toBe(30);
    expect(maxKeywordsOf({ maxKeywords: 0 })).toBe(30);
    expect(maxKeywordsOf({ maxKeywords: 40 })).toBe(40);
  });
});

describe('listing quality pass', () => {
  const field = (fieldId: string, fieldName: string, content: string, maxChars: number) => ({
    fieldId, fieldName, content, charCount: content.length, maxChars, keywordsUsed: [], certifiedCount: 0, fillerCount: 0,
  });

  it('measures short fields, a Brand that copies the Title, and repetitive bullets', () => {
    const issues = listingQualityIssues([
      field('title', 'Title', 'Halloween Ghost Funny Boo-tiful Pumpkin Pride', 60),
      field('brand', 'Brand', 'Pumpkin Halloween Candy Patch Funny Ghost', 50),
      field('bullet-1', 'Bullet', 'halloween ghost halloween fun halloween party for pumpkin fans', 256),
    ]);
    expect(issues.some((i) => i.startsWith('Title (id "title") is 45/60'))).toBe(true);
    expect(issues.some((i) => i.startsWith('Brand (id "brand") is 41/50'))).toBe(true);
    expect(issues.some((i) => i.includes('Brand reuses') && i.includes('halloween'))).toBe(true);
    expect(issues.some((i) => i.includes('"halloween" 3 times'))).toBe(true);
  });

  it('a full, varied listing has no issues', () => {
    const b = 'x'.repeat(230);
    expect(
      listingQualityIssues([
        field('title', 'Title', 'Boo-tiful Halloween Ghost Candy Corn Pride Funny Spooky Art', 60),
        field('brand', 'Brand', 'Witchy Moonlit Forest Bats Trick Treat Studio', 50),
        field('bullet-1', 'Bullet', b, 256),
      ])
    ).toEqual([]);
  });

  it('asks for one revision and keeps it only when it fixes more problems', async () => {
    const chat = vi.mocked(chatCompletion);
    chat.mockReset();
    chat
      .mockResolvedValueOnce(JSON.stringify({ title: 'Cat Mom', brand: 'Cat Mom Club' }))
      .mockResolvedValueOnce(JSON.stringify({ title: 'Cat Mom Coffee Lover Funny Kitty Retro Sunset Vibes Cute Pet', brand: 'Feline Fan Weekend Purr Studio Whisker Crew' }));
    const listing = await generateListing({
      apiKey: 'k',
      validatedKeywords: [keyword],
      config: { ...DEFAULT_LISTING_CONFIG, fields: [{ id: 'title', name: 'Title', maxChars: 60 }, { id: 'brand', name: 'Brand', maxChars: 50 }], forbiddenWords: [] },
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(String(chat.mock.calls[1][1])).toContain('REVISE THE DRAFT');
    expect(listing.fields[0].content).toBe('Cat Mom Coffee Lover Funny Kitty Retro Sunset Vibes Cute Pet');

    chat.mockReset();
    chat
      .mockResolvedValueOnce(JSON.stringify({ title: 'Cat Mom', brand: 'Kitty Crew' }))
      .mockResolvedValueOnce(JSON.stringify({ title: 'Cat', brand: 'Cat Mom' }));
    const kept = await generateListing({
      apiKey: 'k',
      validatedKeywords: [keyword],
      config: { ...DEFAULT_LISTING_CONFIG, fields: [{ id: 'title', name: 'Title', maxChars: 60 }, { id: 'brand', name: 'Brand', maxChars: 50 }], forbiddenWords: [] },
    });
    expect(kept.fields[0].content).toBe('Cat Mom'); // worse revision rejected
  });
});

