import { ValidatedKeyword, ImageAnalysis } from '../types';
import { chatCompletion, extractAiJson, type AIConfig } from '@/lib/ai-provider';

// Words that are useless as standalone keywords - they don't describe a specific design
// Someone searching these + "tshirt" would NOT be looking for a specific design
const USELESS_STANDALONE_WORDS = new Set([
  // Colors - people searching "black tshirt" want a black-colored shirt
  'black',
  'white',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'gray',
  'grey',
  'gold',
  'silver',
  'navy',
  'teal',
  // Generic descriptors - too vague to attract the right buyer
  'character',
  'characters',
  'art',
  'arts',
  'design',
  'designs',
  'style',
  'styles',
  'cool',
  'awesome',
  'nice',
  'good',
  'great',
  'best',
  'top',
  'new',
  'vintage',
  'retro',
  'classic',
  'modern',
  'simple',
  'minimal',
  'minimalist',
  'graphic',
  'graphics',
  'print',
  'prints',
  'illustration',
  'drawing',
  'image',
  'picture',
  'logo',
  'icon',
  'symbol',
  'pattern',
  'man',
  'men',
  'woman',
  'women',
  'person',
  'people',
  'guy',
  'girl',
  'adult',
  'adults',
  'male',
  'female',
  'human',
  // Actions that are too generic
  'action',
  'pose',
  'posing',
  'standing',
  'sitting',
]);

/**
 * Check if a keyword is useless as a standalone search term
 */
function isUselessKeyword(word: string): boolean {
  const lower = word.toLowerCase().trim();
  // Only filter single words, not phrases
  if (lower.includes(' ')) return false;
  return USELESS_STANDALONE_WORDS.has(lower);
}

export const RANKING_PROMPT = `
You are ranking keywords for an Amazon Merch listing.

DESIGN ANALYSIS:
{analysis}

KEYWORDS TO RANK:
{keywords}

THE ONE TEST THAT MATTERS:
For EACH keyword, imagine someone typing "[keyword] tshirt" into Amazon search.
Would they be HAPPY to see this design in their results?

- YES, this is what they want → Rank HIGH
- MAYBE, tangentially related → Rank LOW
- NO, they'd be disappointed → Push to BOTTOM

EXAMPLES (for a karate guy design):
- "karate" → HIGH (exactly what they want)
- "martial arts" → HIGH (they'd love this)
- "black belt" → HIGH (perfect match)
- "fighter" → MEDIUM (might work)
- "sports" → LOW (too generic, they want specific sports)
- "arts" → BOTTOM (they want paintings/creative stuff, not martial arts)
- "black" → BOTTOM (they want black-colored shirts)
- "asian" → BOTTOM (too broad, not what they're searching for)

THINK LIKE A SHOPPER:
- Someone searching "karate tshirt" WANTS a karate design ✓
- Someone searching "arts tshirt" wants art/paintings, NOT martial arts ✗
- Someone searching "black tshirt" wants a black shirt, NOT a design with black in it ✗

Return ONLY a JSON array in ranked order (best keywords first):
["keyword1", "keyword2", "keyword3", ...]
`;

interface RankKeywordsOptions {
  apiKey: string;
  analysis: ImageAnalysis;
  validatedKeywords: ValidatedKeyword[];
  aiConfig?: AIConfig;
  /** Called when AI ranking is skipped (API error / unparseable response) and
   *  the ORIGINAL order is returned. Without this the caller renders an
   *  unranked list that looks ranked — surface it so the UI can say so. */
  onRankingSkipped?: (reason: string) => void;
}

export async function rankKeywords(options: RankKeywordsOptions): Promise<ValidatedKeyword[]> {
  const { apiKey, analysis, validatedKeywords, aiConfig, onRankingSkipped } = options;

  // Only rank certified keywords that are selected
  const certifiedKeywords = validatedKeywords.filter((kw) => kw.certified);

  if (certifiedKeywords.length === 0) {
    return validatedKeywords;
  }

  const keywordList = certifiedKeywords.map((kw) => kw.word);

  const prompt = RANKING_PROMPT.replace('{analysis}', JSON.stringify(analysis, null, 2)).replace(
    '{keywords}',
    keywordList.join(', ')
  );

  const config: AIConfig = aiConfig || { provider: 'openai', apiKey };

  let rawResponse: string;
  try {
    rawResponse = await chatCompletion(config, prompt, {
      model: 'gpt-4o-mini',
      maxTokens: 500,
    });
  } catch (err) {
    console.error('Ranking API error:', err);
    onRankingSkipped?.(err instanceof Error ? err.message : 'ranking request failed');
    return validatedKeywords;
  }

  // Parse the JSON array (fenced block first, then greedy fallback)
  const jsonText = extractAiJson(rawResponse, 'array');
  if (!jsonText) {
    console.error('Failed to parse ranking response');
    onRankingSkipped?.('ranking response was not valid JSON');
    return validatedKeywords;
  }

  try {
    const rankedWords: string[] = JSON.parse(jsonText);

    // Create a map for quick lookup of rank
    const rankMap = new Map<string, number>();
    rankedWords.forEach((word, index) => {
      rankMap.set(word.toLowerCase(), index);
    });

    // Sort validated keywords with multiple tiers:
    // 1. Certified + useful keywords (sorted by AI rank)
    // 2. Certified + useless keywords (colors, generic words)
    // 3. Non-certified keywords
    const sorted = [...validatedKeywords].sort((a, b) => {
      const aUseless = isUselessKeyword(a.word);
      const bUseless = isUselessKeyword(b.word);

      // Non-certified always go to the very end
      if (a.certified && !b.certified) return -1;
      if (!a.certified && b.certified) return 1;

      // Both certified: useless keywords go after useful ones
      if (a.certified && b.certified) {
        if (!aUseless && bUseless) return -1;
        if (aUseless && !bUseless) return 1;

        // Both same tier: sort by AI rank
        const rankA = rankMap.get(a.word.toLowerCase()) ?? 999;
        const rankB = rankMap.get(b.word.toLowerCase()) ?? 999;
        return rankA - rankB;
      }

      // Both non-certified: keep original order
      return 0;
    });

    return sorted;
  } catch {
    console.error('Failed to parse ranked keywords');
    onRankingSkipped?.('ranking response was not valid JSON');
    return validatedKeywords;
  }
}
