import { describe, it, expect, vi } from 'vitest';
import { createManualCandidate } from './generateCandidates';

describe('createManualCandidate', () => {
  it('creates a candidate with manual source', () => {
    const c = createManualCandidate('coffee lover');
    expect(c.source).toBe('manual');
    expect(c.word).toBe('coffee lover');
    expect(c.isPhrase).toBe(true);
  });

  it('lowercases and trims the word', () => {
    const c = createManualCandidate('  Cat  ');
    expect(c.word).toBe('cat');
  });

  it('marks single words as non-phrases', () => {
    const c = createManualCandidate('cat');
    expect(c.isPhrase).toBe(false);
  });

  it('assigns a unique id', () => {
    const a = createManualCandidate('cat');
    const b = createManualCandidate('cat');
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe('generateCandidates', () => {
  it('returns deduped candidates from AI response', async () => {
    vi.resetModules();
    const { generateCandidates } = await import('./generateCandidates');
    const aiMod = await import('@/lib/ai-provider');
    vi.spyOn(aiMod, 'chatCompletion').mockResolvedValue(
      JSON.stringify({
        visual: ['cat', 'coffee cup'],
        text: ['monday mood'],
        who: ['cat lover'],
        what: ['holding coffee'],
        why: ['humor'],
        when: ['morning'],
        where: ['work'],
        lsi: ['feline', 'espresso', 'cat'], // "cat" is a duplicate
      })
    );

    const analysis = {
      visualElements: ['cat'],
      detectedText: [],
      mood: 'funny',
      style: 'cartoon',
      colors: [],
      rawResponse: '',
    };

    const result = await generateCandidates({ apiKey: 'test', analysis });
    const words = result.map((r) => r.word);
    // Should deduplicate "cat"
    expect(words.filter((w) => w === 'cat')).toHaveLength(1);
    expect(words).toContain('coffee cup');
    expect(words).toContain('monday mood');
  });

  it('throws when AI response is not valid JSON', async () => {
    vi.resetModules();
    const { generateCandidates } = await import('./generateCandidates');
    const aiMod = await import('@/lib/ai-provider');
    vi.spyOn(aiMod, 'chatCompletion').mockResolvedValue('not json at all');

    await expect(
      generateCandidates({
        apiKey: 'test',
        analysis: {
          visualElements: [],
          detectedText: [],
          mood: '',
          style: '',
          colors: [],
          rawResponse: '',
        },
      })
    ).rejects.toThrow('Failed to parse AI response as JSON');
  });
});
