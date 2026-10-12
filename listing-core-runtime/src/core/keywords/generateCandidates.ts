import { ImageAnalysis, CandidateKeyword, KeywordSource, ALL_FORBIDDEN_WORDS } from '../types';
import { chatCompletion, extractAiJson, type AIConfig } from '@/lib/ai-provider';

function buildCandidatePrompt(analysis: ImageAnalysis, forbiddenWords: string[]): string {
  return `Based on this design analysis, generate keyword candidates for an Amazon listing.

DESIGN ANALYSIS:
${JSON.stringify(analysis, null, 2)}

Generate keywords in these categories:

1. VISUAL: Nouns — what objects, people, animals, or things are in the image? (cat, guitar, mountains, couple)
2. TEXT: Keywords from any text on the design
3. WHO: Who would wear this? (demographics, identities, occupations)
4. WHAT: Actions and descriptions — what is happening, and how would you describe it? Include verbs/actions (holding hands, playing guitar, riding a bike), adjectives (funny, grumpy, vintage, retro), and phrases that describe the scene (sunset over mountains, cat drinking coffee)
5. WHY: Why would they buy it? (humor, pride, statement)
6. WHEN: When would they wear it? (season, day, occasion)
7. WHERE: Where would they wear it? (work, gym, casual)
8. LSI: Semantically related keywords (synonyms, related concepts, proverbs, sayings)

Rules:
- Include both single words AND phrases (2-3 words max)
- Be specific (not just "funny" but "cat humor", "coffee jokes")
- Think like a buyer searching Amazon
- Include common misspellings if relevant

DEDUPLICATION RULE:
- If you include a multi-word phrase like "elf couple", do NOT also include the individual words "elf" or "couple" as standalone keywords — they are redundant.
- Only include a single word on its own if it adds meaning BEYOND any phrase it appears in.

CRITICAL TEST - For EACH keyword, ask yourself:
"If someone searched '[keyword] tshirt' on Amazon, would they be HAPPY to find this design?"
- If YES → Include it
- If NO → Don't include it
Example: For a karate design, "martial arts" passes (they'd want it), but "arts" fails (they want paintings, not martial arts)

FORBIDDEN WORDS - Do NOT include these:
${forbiddenWords.join(', ')}
Also: NO STANDALONE COLORS (black, white, red, blue, etc.) — colors IN PHRASES are OK ("black cat", "red rose").

Respond in this exact JSON format:
{
  "visual": ["keyword1", "keyword2"],
  "text": ["keyword1", "keyword2"],
  "who": ["keyword1", "keyword2"],
  "what": ["keyword1", "keyword2"],
  "why": ["keyword1", "keyword2"],
  "when": ["keyword1", "keyword2"],
  "where": ["keyword1", "keyword2"],
  "lsi": ["keyword1", "keyword2"]
}`;
}

interface GenerateCandidatesOptions {
  apiKey: string;
  analysis: ImageAnalysis;
  forbiddenWords?: string[];
  aiConfig?: AIConfig;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function createCandidate(word: string, source: KeywordSource): CandidateKeyword {
  return {
    id: generateId(),
    word: word.toLowerCase().trim(),
    source,
    isPhrase: word.trim().includes(' '),
  };
}

export async function generateCandidates(
  options: GenerateCandidatesOptions
): Promise<CandidateKeyword[]> {
  const { apiKey, analysis, aiConfig, forbiddenWords = ALL_FORBIDDEN_WORDS } = options;

  const prompt = buildCandidatePrompt(analysis, forbiddenWords);

  const config: AIConfig = aiConfig || { provider: 'openai', apiKey };
  const rawResponse = await chatCompletion(config, prompt, {
    model: 'gpt-4o',
    maxTokens: 1500,
  });

  // Parse the JSON response (fenced block first, then greedy fallback)
  const jsonText = extractAiJson(rawResponse);
  if (!jsonText) {
    throw new Error('Failed to parse AI response as JSON');
  }

  const parsed = JSON.parse(jsonText);

  // Convert to CandidateKeyword array
  const candidates: CandidateKeyword[] = [];
  const sourceMap: Record<string, KeywordSource> = {
    visual: 'visual',
    text: 'text',
    who: 'who',
    what: 'what',
    why: 'why',
    when: 'when',
    where: 'where',
    lsi: 'lsi',
  };

  for (const [key, source] of Object.entries(sourceMap)) {
    const keywords = parsed[key] || [];
    for (const word of keywords) {
      if (word && typeof word === 'string') {
        candidates.push(createCandidate(word, source));
      }
    }
  }

  // Deduplicate by word
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.word)) return false;
    seen.add(c.word);
    return true;
  });
}

// Helper to add a manual keyword
export function createManualCandidate(word: string): CandidateKeyword {
  return createCandidate(word, 'manual');
}
