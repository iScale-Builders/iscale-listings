/**
 * Text normalization pipeline.
 * CRITICAL: This must produce byte-identical output to the Python version in
 * scripts/text_normalize.py. Both are tested against the same
 * tests/fixtures/normalization-vectors.json fixture.
 *
 * Steps (applied in order):
 * 1. NFKD compatibility-decompose. Folds stylized glyphs POD sellers use as
 *    evasion — full-width (ＮＩＫＥ), math-alphanumeric (𝐍𝐢𝐤𝐞), ligatures (ﬁ) —
 *    down to plain letters, and decomposes accents to base + combining mark.
 *    Done BEFORE lowercasing so case-mapping only ever runs on plain letters,
 *    which keeps JS and Python byte-identical (their case maps for exotic
 *    codepoints differ; for ASCII/Latin they agree).
 * 2. Lowercase.
 * 3. Drop Unicode "Mn" (nonspacing mark) chars. This folds accents
 *    (café -> cafe) instead of deleting the letter. Deleting accented letters
 *    shredded words ("café" -> "caf") and caused false "no match" results, the
 *    worst failure mode for a screening tool.
 * 4. Fold non-decomposing Latin letters NFKD can't handle (see SPECIAL_FOLD).
 * 5. Strip apostrophes (' and ’)
 * 6. Hyphens to spaces
 * 7. Remove all non-alphanumeric except spaces
 * 8. Collapse whitespace
 * 9. Trim
 */

// Non-decomposing Latin letters NFD leaves intact. Keep byte-identical to
// _SPECIAL_FOLD in scripts/text_normalize.py.
const SPECIAL_FOLD: ReadonlyArray<readonly [string, string]> = [
  ['ß', 'ss'],
  ['ø', 'o'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ł', 'l'],
  ['đ', 'd'],
];

export function normalizeText(text: string): string {
  let result = text
    .normalize('NFKD') // fold full-width / math / ligature glyphs to plain letters
    .toLowerCase()
    .replace(/\p{Mn}/gu, ''); // strip accents (nonspacing marks)

  for (const [src, dst] of SPECIAL_FOLD) {
    result = result.split(src).join(dst);
  }

  return result
    .replace(/['’]/g, '')      // strip apostrophes
    .replace(/-/g, ' ')             // hyphens to spaces
    .replace(/[^a-z0-9\s]/g, ' ')   // remove non-alphanumeric except spaces
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}
