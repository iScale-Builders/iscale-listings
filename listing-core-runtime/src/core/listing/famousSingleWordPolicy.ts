/**
 * Conservative exceptions to the ordinary-single-word trademark policy.
 *
 * Keep the data and normalization here because the listing core, extension,
 * and agentic CLI must never drift into different safety decisions.
 */
export const FAMOUS_SINGLE_WORD_BRANDS = Object.freeze([
  'adidas',
  'amazon',
  'apple',
  'chanel',
  'disney',
  'google',
  'gucci',
  'lego',
  'marvel',
  'microsoft',
  'nike',
  'nintendo',
  'pepsi',
  'playstation',
  'pokemon',
  'prada',
  'reebok',
  'rolex',
  'xbox',
]);

const famousSingleWordBrandSet = new Set(FAMOUS_SINGLE_WORD_BRANDS);

export function normalizeFamousSingleWordBrand(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isFamousSingleWordBrand(value: unknown): boolean {
  return famousSingleWordBrandSet.has(normalizeFamousSingleWordBrand(value));
}
