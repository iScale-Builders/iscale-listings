import { f as HighlightOptions } from './types-C1Llomcy.cjs';
export { T as TrademarkMatch } from './types-C1Llomcy.cjs';

/**
 * Highlight trademark matches inside DOM elements using mark.js.
 *
 * This module is tree-shakeable: it is a separate entry point
 * (`@iscale/trademark-checker/highlight`) and will not be bundled
 * unless explicitly imported.
 *
 * Requires `mark.js` as a peer dependency.
 */
declare function highlight(options: HighlightOptions): void;
/**
 * Remove all iScaleListings highlights from the given elements, or from
 * the entire document if no elements are provided.
 */
declare function clearHighlights(elements?: HTMLElement[]): void;

export { HighlightOptions, clearHighlights, highlight };
