import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ValidatedKeyword, ImageAnalysis } from '../types';

const mockChatCompletion = vi.fn();

vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai-provider')>()),
  chatCompletion: mockChatCompletion,
}));

const { rankKeywords } = await import('./rankKeywords');

const mockAnalysis: ImageAnalysis = {
  visualElements: ['cat', 'coffee cup'],
  detectedText: [],
  mood: 'funny',
  style: 'cartoon',
  colors: ['orange', 'brown'],
  rawResponse: '',
};

function makeKeyword(word: string, certified = true): ValidatedKeyword {
  return {
    id: word,
    word,
    source: 'visual',
    isPhrase: word.includes(' '),
    subWords: [],
    validations: [],
    certified,
    bestPosition: certified ? 1 : null,
    bestVariant: certified ? 'shirt' : null,
    selected: certified,
  };
}

describe('rankKeywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns original list when no certified keywords', async () => {
    const kws = [makeKeyword('cat', false), makeKeyword('funny', false)];
    const result = await rankKeywords({
      apiKey: 'test',
      analysis: mockAnalysis,
      validatedKeywords: kws,
    });
    expect(result).toEqual(kws);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('keeps uncertified keywords at the end', async () => {
    mockChatCompletion.mockResolvedValue('["cat", "coffee lover"]');

    const kws = [
      makeKeyword('cat', true),
      makeKeyword('uncertified-term', false),
      makeKeyword('coffee lover', true),
    ];

    const result = await rankKeywords({
      apiKey: 'test',
      analysis: mockAnalysis,
      validatedKeywords: kws,
    });

    const lastItem = result[result.length - 1];
    expect(lastItem.certified).toBe(false);
  });

  it('filters useless standalone keywords to end of certified group', async () => {
    mockChatCompletion.mockResolvedValue('["cat", "black"]');
    const kws = [makeKeyword('black', true), makeKeyword('cat', true)];

    const result = await rankKeywords({
      apiKey: 'test',
      analysis: mockAnalysis,
      validatedKeywords: kws,
    });

    const catIdx = result.findIndex((k) => k.word === 'cat');
    const blackIdx = result.findIndex((k) => k.word === 'black');
    expect(catIdx).toBeLessThan(blackIdx);
  });

  it('handles AI parse failure gracefully', async () => {
    mockChatCompletion.mockResolvedValue('invalid json {{');
    const kws = [makeKeyword('cat'), makeKeyword('funny')];
    const result = await rankKeywords({
      apiKey: 'test',
      analysis: mockAnalysis,
      validatedKeywords: kws,
    });
    expect(result).toHaveLength(2);
  });
});
