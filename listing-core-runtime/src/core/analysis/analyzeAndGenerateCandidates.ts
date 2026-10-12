// One vision round trip for the two dependent design tasks. Original prompts
// and response normalization stay in their owning modules; invalid merged JSON
// falls back in the orchestrator, never into partially trusted keyword output.
import { ANALYSIS_PROMPT, imageAnalysisFromParsed } from './analyzeImage';
import { buildCandidatePrompt, candidatesFromParsed } from '../keywords/generateCandidates';
import { ALL_FORBIDDEN_WORDS, type ImageAnalysis, type CandidateKeyword } from '../types';
import { extractAiJson, visionCompletion, type AIConfig } from '@/lib/ai-provider';

const ANALYSIS_KEYS = ['visualElements', 'detectedText', 'style', 'mood', 'colors'];
const CANDIDATE_KEYS = ['visual', 'text', 'who', 'what', 'why', 'when', 'where', 'lsi'];
export class InvalidCombinedDesignResponse extends Error {
  constructor() { super('Combined design response was invalid; use the original analysis/candidate path'); }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(word => typeof word === 'string' && word.trim().length > 0);
}

export function parseCombinedDesignResponse(raw: string): { analysis: ImageAnalysis; candidates: CandidateKeyword[] } {
  try {
    const json = extractAiJson(raw);
    if (!json) throw new InvalidCombinedDesignResponse();
    const parsed: unknown = JSON.parse(json);
    if (!record(parsed) || !exactKeys(parsed, ['analysis', 'candidates']) || !record(parsed.analysis) || !record(parsed.candidates)) throw new InvalidCombinedDesignResponse();
    const analysis = parsed.analysis;
    const keywords = parsed.candidates;
    if (!exactKeys(analysis, ANALYSIS_KEYS) || !exactKeys(keywords, CANDIDATE_KEYS)
      || !strings(analysis.visualElements) || !strings(analysis.detectedText) || !strings(analysis.colors)
      || typeof analysis.style !== 'string' || !analysis.style.trim() || typeof analysis.mood !== 'string' || !analysis.mood.trim()
      || (!analysis.visualElements.length && !analysis.detectedText.length)
      || !CANDIDATE_KEYS.every(key => strings(keywords[key]))) throw new InvalidCombinedDesignResponse();
    const candidates = candidatesFromParsed(keywords);
    if (!candidates.length) throw new InvalidCombinedDesignResponse();
    // Later ranking still sees an analysis-only rawResponse, as on the original path.
    return { analysis: imageAnalysisFromParsed(analysis, JSON.stringify(analysis)), candidates };
  } catch (error) {
    if (error instanceof InvalidCombinedDesignResponse) throw error;
    throw new InvalidCombinedDesignResponse();
  }
}

export function combinedDesignPrompt(forbiddenWords: string[] = ALL_FORBIDDEN_WORDS): string {
  const placeholder: ImageAnalysis = { visualElements: [], detectedText: [], style: '', mood: '', colors: [], rawResponse: '' };
  const candidateRules = buildCandidatePrompt(placeholder, forbiddenWords)
    .replace(JSON.stringify(placeholder, null, 2), 'Use the complete analysis object you produced in TASK 1; derive candidates from this image, not these instructions.');
  const example = { analysis: { visualElements: ['visible item'], detectedText: [], style: 'art style', mood: 'emotional tone', colors: ['main color'] }, candidates: { visual: ['relevant keyword'], text: [], who: [], what: [], why: [], when: [], where: [], lsi: [] } };
  return `Complete these two tasks in order, using the same attached design image.\n\nTASK 1 — IMAGE ANALYSIS\n${stripResponseExample(ANALYSIS_PROMPT)}\n\nTASK 2 — KEYWORD CANDIDATES\n${stripResponseExample(candidateRules)}\n\nRespond in this exact JSON format:\n${JSON.stringify(example, null, 2)}\nReturn exactly the two keys and every nested field shown, replacing example values with this design's actual analysis and relevant keywords. Every listed array contains strings; use [] when that category is absent. Do not invent text that is not on the image. No prose or additional keys.`;
}

/** Remove only a standalone response wrapper; rules before/after it survive. */
export function stripResponseExample(prompt: string): string {
  const marker = 'Respond in this exact JSON format:';
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error('Original response example marker missing');
  const open = prompt.indexOf('{', start + marker.length);
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = open; index >= 0 && index < prompt.length; index++) {
    const character = prompt[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return prompt.slice(0, start) + prompt.slice(index + 1);
  }
  throw new Error('Original response example was not balanced');
}

export async function analyzeAndGenerateCandidates(options: { imageBase64: string; aiConfig: AIConfig; forbiddenWords?: string[] }): Promise<{ analysis: ImageAnalysis; candidates: CandidateKeyword[] }> {
  const raw = await visionCompletion(options.aiConfig, options.imageBase64, combinedDesignPrompt(options.forbiddenWords), { model: 'gpt-4o', maxTokens: 2500 });
  return parseCombinedDesignResponse(raw);
}
