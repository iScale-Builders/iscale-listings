import { describe, it, expect } from 'vitest';
import { combinedDesignPrompt, parseCombinedDesignResponse, InvalidCombinedDesignResponse, stripResponseExample } from './analyzeAndGenerateCandidates';
import { candidatesFromParsed } from '../keywords/generateCandidates';

const analysis = { visualElements: ['cat'], detectedText: ['Monday Mood'], style: 'cartoon', mood: 'funny', colors: ['orange'] };
const candidates = { visual: [' Cat ', 'cat'], text: ['Monday Mood'], who: ['cat dad'], what: [], why: [], when: [], where: [], lsi: [] };
const valid = () => ({ analysis: { ...analysis }, candidates: { ...candidates } });

describe('combined design response', () => {
  it('reuses original source assignment, normalization and deduplication with analysis-only raw JSON', () => {
    const result = parseCombinedDesignResponse(JSON.stringify(valid()));
    const withoutIds = (rows: ReturnType<typeof candidatesFromParsed>) => rows.map(({ id: _id, ...row }) => row);
    expect(withoutIds(result.candidates)).toEqual(withoutIds(candidatesFromParsed(candidates)));
    expect(JSON.parse(result.analysis.rawResponse)).toEqual(analysis);
    expect(result.analysis.rawResponse).not.toContain('candidates');
  });
  it.each([
    ['missing category', { analysis, candidates: { visual: ['cat'] } }],
    ['wrong candidate type', { analysis, candidates: { ...candidates, lsi: [42] } }],
    ['empty candidates', { analysis, candidates: Object.fromEntries(Object.keys(candidates).map(key => [key, []])) }],
    ['empty analysis', { analysis: { ...analysis, visualElements: [], detectedText: [] }, candidates }],
    ['missing analysis field', { analysis: { ...analysis, mood: undefined }, candidates }],
    ['extra field', { ...valid(), extra: true }],
    ['blank candidate', { analysis, candidates: { ...candidates, who: [' '] } }],
  ])('rejects %s for explicit original-path fallback', (_label, payload) => {
    expect(() => parseCombinedDesignResponse(JSON.stringify(payload))).toThrow(InvalidCombinedDesignResponse);
  });
  it('rejects non-JSON', () => expect(() => parseCombinedDesignResponse('unusable response')).toThrow(InvalidCombinedDesignResponse));
  it('retains original analysis/candidate rules and requested banned words', () => {
    const prompt = combinedDesignPrompt(['customban']);
    expect(prompt).toContain('customban');
    expect(prompt).toContain('TASK 1');
    expect(prompt).toContain('TASK 2');
    expect(prompt).not.toContain('"rawResponse": ""');
    expect(prompt.match(/Respond in this exact JSON format:/g)).toHaveLength(1);
    expect(prompt).toContain('Be specific and thorough. Include both obvious and subtle elements.');
    expect(prompt).toContain('DEDUPLICATION RULE:');
    expect(prompt).toContain('NO STANDALONE COLORS');
    const schema = JSON.parse(prompt.slice(prompt.indexOf('Respond in this exact JSON format:') + 'Respond in this exact JSON format:'.length, prompt.indexOf('Return exactly the two keys')).trim());
    expect(Object.keys(schema.analysis)).toEqual(['visualElements', 'detectedText', 'style', 'mood', 'colors']);
    expect(Object.keys(schema.candidates)).toEqual(['visual', 'text', 'who', 'what', 'why', 'when', 'where', 'lsi']);
  });
  it('removes only a balanced wrapper and preserves trailing rules', () => {
    expect(stripResponseExample('before\nRespond in this exact JSON format:\n{"nested":{"text":"brace } and escaped \\\" quote"}}\nafter')).toBe('before\n\nafter');
  });
});
