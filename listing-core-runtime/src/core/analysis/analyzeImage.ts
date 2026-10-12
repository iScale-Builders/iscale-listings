import { ImageAnalysis } from '../types';
import { extractAiJson, visionCompletion, type AIConfig } from '@/lib/ai-provider';

export const ANALYSIS_PROMPT = `
Analyze this t-shirt design image and extract:

1. VISUAL ELEMENTS: List all objects, characters, items visible (e.g., "grumpy cat", "coffee cup", "stars")

2. TEXT DETECTED: Any text/words visible on the design (exact text)

3. STYLE: Art style (e.g., "cartoon", "vintage", "minimalist", "hand-drawn")

4. MOOD: Emotional tone (e.g., "sarcastic", "wholesome", "funny", "inspirational")

5. COLORS: Main colors used

Respond in this exact JSON format:
{
  "visualElements": ["item1", "item2"],
  "detectedText": ["text1", "text2"],
  "style": "style description",
  "mood": "mood description",
  "colors": ["color1", "color2"]
}

Be specific and thorough. Include both obvious and subtle elements.
`;

interface AnalyzeImageOptions {
  apiKey: string;
  imageBase64: string; // data URL format
  aiConfig?: AIConfig;
}

export async function analyzeImage(options: AnalyzeImageOptions): Promise<ImageAnalysis> {
  const { apiKey, imageBase64, aiConfig } = options;

  const config: AIConfig = aiConfig || { provider: 'openai', apiKey };
  const rawResponse = await visionCompletion(config, imageBase64, ANALYSIS_PROMPT, {
    model: 'gpt-4o',
    maxTokens: 1000,
  });

  // Parse the JSON response (fenced block first, then greedy fallback)
  const jsonText = extractAiJson(rawResponse);
  if (!jsonText) {
    throw new Error('Failed to parse AI response as JSON');
  }

  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Image analysis JSON was not an object');
  }

  // The model can return the wrong shape (a string for an array field, etc.);
  // coerce defensively so a malformed field can't crash the caller's `.map`/`.join`.
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  return {
    visualElements: strArray(parsed.visualElements),
    detectedText: strArray(parsed.detectedText),
    mood: str(parsed.mood),
    style: str(parsed.style),
    colors: strArray(parsed.colors),
    rawResponse,
  };
}
