import { CandidateKeyword, ValidatedKeyword, ValidationCheck, AutosuggestFetcher } from '../types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when none of these checks actually completed — every one errored
 *  (rate-limit/network) — so a `certified: false` means "couldn't verify", not
 *  "verified absent". Used to flag keywords the UI must not present as clean misses. */
function allErrored(checks: ValidationCheck[]): boolean {
  return checks.length > 0 && checks.every((v) => v.errored === true);
}

interface ValidateBatchOptions {
  concurrency?: number;
  delayBetweenBatches?: number;
  onProgress?: (percent: number) => void;
}

const DEFAULT_OPTIONS: Required<ValidateBatchOptions> = {
  concurrency: 10,
  delayBetweenBatches: 100,
  onProgress: () => {},
};

// Product/variant words allowed to trail a keyword and still count as a head
// match (e.g. "cat mom shirt" certifies "cat mom"). normKw strips punctuation,
// so "t-shirt" is listed as "t shirt"; multi-word entries are stripped first.
const VARIANT_WORDS = [
  'long sleeve shirt', 'long sleeve', 'baseball tee', 'tank tops', 'tank top',
  'throw pillows', 'throw pillow', 'phone holder', 'phone grip', 'tote bags', 'tote bag',
  't shirts', 't shirt', 'tshirts', 'tshirt', 'tees', 'tee', 'shirts', 'shirt',
  'hoodies', 'hoodie', 'sweatshirts', 'sweatshirt', 'sweaters', 'sweater',
  'crewnecks', 'crewneck', 'pullovers', 'pullover', 'raglans', 'raglan', 'tanks', 'tank',
  'popsockets', 'popsocket', 'pillows', 'pillow', 'totes', 'tote',
];

/** Normalize for comparison: lowercase, punctuation → space, collapse whitespace. */
function normKw(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A keyword counts as found ONLY when it is the HEAD of a suggestion — the
 * suggestion is the keyword itself, or the keyword followed solely by product
 * words (shirt, hoodie, …). This is the real autosuggest signal: the keyword is
 * a searched term in this product context.
 *
 * It rejects the old false positive where a keyword was "found" just because it
 * appeared as a fragment inside a different, longer phrase — e.g. "going fast"
 * being certified by the suggestion "going fast is not a crime shirt".
 */
function isHeadMatch(keyword: string, suggestion: string, allVariants: string[]): boolean {
  const k = normKw(keyword);
  if (!k) return false;
  const s = normKw(suggestion);
  if (s === k) return true;
  if (!s.startsWith(k + ' ')) return false;

  // Everything after the keyword must be product/variant words only.
  let rest = s.slice(k.length).trim();
  const strip = Array.from(new Set([...allVariants.map(normKw), ...VARIANT_WORDS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // multi-word variants first
  // Whole-word replace (not split on ' w ') so adjacent duplicate variant words —
  // e.g. Amazon returning "cat shirt shirt" — are BOTH stripped; a shared
  // delimiter space no longer gets consumed by the first match. Variant words are
  // normalized (alphanumeric + space only), so no regex escaping is needed.
  for (const w of strip) rest = rest.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  return rest.replace(/\s+/g, ' ').trim() === '';
}

/**
 * Position (1-indexed) of the first suggestion the keyword is the HEAD of.
 * Returns null if the keyword never heads a suggestion.
 */
function findPosition(keyword: string, suggestions: string[], allVariants: string[]): number | null {
  for (let i = 0; i < suggestions.length; i++) {
    if (isHeadMatch(keyword, suggestions[i], allVariants)) {
      return i + 1; // 1-indexed
    }
  }
  return null;
}

/**
 * Generate a unique ID
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

/**
 * Validate a single keyword against all product variants
 * Returns an array - phrases may be split into individual words if phrase wasn't found
 */
export async function validateKeyword(
  candidate: CandidateKeyword,
  fetcher: AutosuggestFetcher,
  productVariants: string[]
): Promise<ValidatedKeyword[]> {
  const subWords = candidate.isPhrase ? candidate.word.split(' ').filter(Boolean) : [];

  // Check full keyword with each variant
  const phraseValidations: ValidationCheck[] = [];
  for (const variant of productVariants) {
    const query = `${candidate.word} ${variant}`;
    try {
      const suggestions = await fetcher(query);
      const position = findPosition(candidate.word, suggestions, productVariants);
      phraseValidations.push({
        query,
        productVariant: variant,
        found: position !== null,
        position,
        suggestions,
      });
    } catch {
      phraseValidations.push({
        query,
        productVariant: variant,
        found: false,
        position: null,
        suggestions: [],
        errored: true,
      });
    }
  }

  // Check if full phrase was found
  const phraseFound = phraseValidations.some((v) => v.found);

  // If it's a phrase and the full phrase was NOT found, check and return individual words
  if (candidate.isPhrase && !phraseFound) {
    const results: ValidatedKeyword[] = [];

    for (const word of subWords) {
      const wordValidations: ValidationCheck[] = [];

      for (const variant of productVariants) {
        const query = `${word} ${variant}`;
        try {
          const suggestions = await fetcher(query);
          const position = findPosition(word, suggestions, productVariants);
          wordValidations.push({
            query,
            productVariant: variant,
            found: position !== null,
            position,
            suggestions,
          });
        } catch {
          wordValidations.push({
            query,
            productVariant: variant,
            found: false,
            position: null,
            suggestions: [],
            errored: true,
          });
        }
      }

      const foundChecks = wordValidations.filter((v) => v.found);
      const certified = foundChecks.length > 0;
      const bestPosition = certified ? Math.min(...foundChecks.map((v) => v.position!)) : null;
      const bestVariant = certified
        ? foundChecks.find((v) => v.position === bestPosition)?.productVariant || null
        : null;

      results.push({
        id: generateId(),
        word,
        source: candidate.source,
        isPhrase: false,
        subWords: [],
        validations: wordValidations,
        certified,
        unverified: !certified && allErrored(wordValidations),
        bestPosition,
        bestVariant,
        selected: certified,
      });
    }

    return results;
  }

  // For non-phrases OR phrases that were found as complete phrases.
  //
  // NOTE: found phrases used to ALSO re-query every subword × variant purely to
  // enrich a details view. That multiplied autosuggest traffic several-fold per
  // found phrase (with "All products" ≈20 variants, one 3-word phrase cost 60
  // extra requests) for data no surface renders. The phrase's own validations
  // carry the certification evidence; subword checks are dropped.
  const allValidations = [...phraseValidations];

  const foundChecks = allValidations.filter((v) => v.found);
  const certified = foundChecks.length > 0;
  const bestPosition = certified ? Math.min(...foundChecks.map((v) => v.position!)) : null;
  const bestVariant = certified
    ? foundChecks.find((v) => v.position === bestPosition)?.productVariant || null
    : null;

  return [
    {
      id: candidate.id,
      word: candidate.word,
      source: candidate.source,
      isPhrase: candidate.isPhrase,
      subWords,
      validations: allValidations,
      certified,
      unverified: !certified && allErrored(allValidations),
      bestPosition,
      bestVariant,
      selected: certified,
    },
  ];
}

/**
 * Memoize autosuggest lookups for the duration of one batch. Phrase splits and
 * overlapping candidates repeat identical queries ("cat shirt" can fire from
 * several candidates); each unique query should hit Amazon exactly once per run.
 * Failed lookups are NOT cached — a transient error on one candidate must not
 * poison the same query for later candidates.
 */
function memoizeFetcher(fetcher: AutosuggestFetcher): AutosuggestFetcher {
  const cache = new Map<string, Promise<string[]>>();
  return (prefix: string) => {
    const key = prefix.toLowerCase().trim();
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = Promise.resolve(fetcher(prefix)).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, pending);
    return pending;
  };
}

/**
 * Validate a batch of keywords with concurrency control
 */
export async function validateBatch(
  candidates: CandidateKeyword[],
  fetcher: AutosuggestFetcher,
  productVariants: string[],
  options?: ValidateBatchOptions
): Promise<ValidatedKeyword[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const memoFetcher = memoizeFetcher(fetcher);
  const results: ValidatedKeyword[] = [];

  for (let i = 0; i < candidates.length; i += opts.concurrency) {
    const batch = candidates.slice(i, i + opts.concurrency);

    const batchResults = await Promise.all(
      batch.map((c) => validateKeyword(c, memoFetcher, productVariants))
    );

    // Flatten results since validateKeyword now returns arrays
    results.push(...batchResults.flat());

    // Report progress
    const progress = ((i + batch.length) / candidates.length) * 100;
    opts.onProgress(Math.min(progress, 100));

    // Delay between batches (except for last batch)
    if (i + opts.concurrency < candidates.length) {
      await sleep(opts.delayBetweenBatches);
    }
  }

  // Deduplicate by word (in case same word appears from multiple split phrases)
  const seen = new Set<string>();
  const deduplicated = results.filter((kw) => {
    const key = kw.word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduplicated;
}
