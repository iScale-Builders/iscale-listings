/**
 * Classify match confidence for noise reduction.
 *
 * - Single-word marks < 5 characters -> "low"
 * - Everything else -> "high"
 *
 * All matches are returned; the client decides how to display them.
 */
export function classifyConfidence(
  wordmarkNormalized: string
): 'high' | 'low' {
  const words = wordmarkNormalized.trim().split(/\s+/);
  if (words.length === 1 && wordmarkNormalized.length < 5) {
    return 'low';
  }
  return 'high';
}
