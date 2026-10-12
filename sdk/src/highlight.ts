import type Mark from 'mark.js';
import type { TrademarkMatch, HighlightOptions } from './types.js';

export type { HighlightOptions, TrademarkMatch } from './types.js';

/** CSS class applied to all highlighted elements. */
const HIGHLIGHT_CLASS = 'iscale-tm-highlight';

/** Data attribute storing the serialized match data on each <mark> element. */
const MATCH_DATA_ATTR = 'data-iscale-tm-match';

/** Background colour for high-confidence matches. */
const HIGH_CONFIDENCE_COLOR = '#ea4800';

/** Background colour for low-confidence matches. */
const LOW_CONFIDENCE_COLOR = '#f5a623';

/**
 * Highlight trademark matches inside DOM elements using mark.js.
 *
 * This module is tree-shakeable: it is a separate entry point
 * (`@iscale/trademark-checker/highlight`) and will not be bundled
 * unless explicitly imported.
 *
 * Requires `mark.js` as a peer dependency.
 */
export function highlight(options: HighlightOptions): void {
  const { elements, matches, onClick } = options;

  if (matches.length === 0 || elements.length === 0) {
    return;
  }

  // Lazy-load mark.js (must be available at runtime)
  const MarkJS = loadMarkJS();

  // Inject styles once
  injectStyles();

  // Build a lookup from normalised matched_text -> match
  const matchMap = new Map<string, TrademarkMatch>();
  for (const match of matches) {
    matchMap.set(match.matched_text.toLowerCase(), match);
  }

  const keywords = matches.map((m) => m.matched_text);

  for (const element of elements) {
    const instance: Mark = new MarkJS(element);

    instance.mark(keywords, {
      acrossElements: true,
      separateWordSearch: false,
      className: HIGHLIGHT_CLASS,
      each(markElement: HTMLElement) {
        const textContent = markElement.textContent ?? '';
        const match = matchMap.get(textContent.toLowerCase());
        if (!match) return;

        // Store match data for click handler
        markElement.setAttribute(MATCH_DATA_ATTR, JSON.stringify(match));

        // Apply confidence-based styling
        const color =
          match.confidence === 'high'
            ? HIGH_CONFIDENCE_COLOR
            : LOW_CONFIDENCE_COLOR;
        markElement.style.backgroundColor = color;
        markElement.style.color = '#ffffff';
        markElement.style.borderRadius = '2px';
        markElement.style.padding = '0 2px';
        markElement.style.cursor = onClick ? 'pointer' : 'default';

        // Attach click handler
        if (onClick) {
          markElement.addEventListener('click', (event: MouseEvent) => {
            onClick(match, event);
          });
        }
      },
    });
  }
}

/**
 * Remove all iScaleListings highlights from the given elements, or from
 * the entire document if no elements are provided.
 */
export function clearHighlights(elements?: HTMLElement[]): void {
  const MarkJS = loadMarkJS();

  const targets =
    elements ??
    Array.from(
      document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)
    ).map((el) => el.parentElement).filter(Boolean) as HTMLElement[];

  // Deduplicate parents
  const unique = [...new Set(targets)];

  for (const element of unique) {
    const instance: Mark = new MarkJS(element);
    instance.unmark({ className: HIGHLIGHT_CLASS });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  if (typeof document === 'undefined') return;

  const style = document.createElement('style');
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      transition: background-color 0.15s ease;
    }
    .${HIGHLIGHT_CLASS}:hover {
      filter: brightness(1.15);
    }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

type MarkConstructor = new (element: HTMLElement) => Mark;

function loadMarkJS(): MarkConstructor {
  try {
    // Dynamic require for mark.js -- peer dependency
    const mod = require('mark.js') as MarkConstructor | { default: MarkConstructor };
    // Handle both default and named exports
    if (typeof mod === 'function') return mod;
    if ('default' in mod && typeof mod.default === 'function') return mod.default;
    throw new Error('Could not resolve mark.js constructor');
  } catch {
    throw new Error(
      '@iscale/trademark-checker/highlight requires "mark.js" as a peer dependency. ' +
        'Install it with: npm install mark.js'
    );
  }
}
