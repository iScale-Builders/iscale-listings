// Shared category presets, colors, and IC-class → category mapping.
// Imported by BOTH the side panel (sidepanel.ts) and the page agent
// (content/duo.ts) so they agree on classes, labels, and highlight colors.
// esbuild bundles this into each entry point.

export interface Category {
  readonly label: string;
  readonly classes: string[]; // IC classes this product type covers (3-digit)
  readonly color: string; // base hex used for highlights, dots, active tabs
}

// Neon product-type colors: live marks paint in the plain color.
// The product-type tabs. Order here is the tab order and the legend order.
export const CATEGORIES: readonly Category[] = [
  { label: 'Apparel', classes: ['025'], color: '#39ff14' },
  { label: 'Phone Cases', classes: ['009'], color: '#2979ff' },
  { label: 'Paper / Stickers', classes: ['016'], color: '#ffea00' },
  { label: 'Bags', classes: ['018'], color: '#bc13fe' },
  { label: 'Home Decor', classes: ['020'], color: '#ff6a00' },
  { label: 'Drinkware', classes: ['021'], color: '#00f0ff' },
  { label: 'Blankets', classes: ['024'], color: '#ff2bd6' },
];

/** Tab text with the class code in front, e.g. "25 - Apparel"; "All POD" stays as is. */
export function categoryTabLabel(c: Category): string {
  if (c.label === 'All POD') return c.label;
  return `${c.classes.map((x) => x.slice(-2)).join('/')} - ${c.label}`;
}

// "All POD" is a meta-tab: it searches every class above and its list shows
// everything. Highlights are still colored per real class, not with this color.
export const ALL_POD: Category = {
  label: 'All POD',
  classes: ['009', '016', '018', '020', '021', '024', '025'],
  color: '#475569',
};

export const ALL_CATEGORIES: readonly Category[] = [...CATEGORIES, ALL_POD];


/** Normalize an IC value ("IC 025", "25", "025", "Class 9") to 3 digits, or ''. */
export function normalizeClass(raw: string | null | undefined): string {
  if (raw == null) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';
  return digits.padStart(3, '0').slice(-3);
}

const CLASS_TO_CATEGORY = new Map<string, Category>();
for (const c of CATEGORIES) for (const cls of c.classes) CLASS_TO_CATEGORY.set(cls, c);

/** The product-type category that owns a match's IC class, if any. */
export function categoryForClass(raw: string | null | undefined): Category | undefined {
  return CLASS_TO_CATEGORY.get(normalizeClass(raw));
}

/** Label + color for a match's class, or null for a class outside the POD
 *  tabs. Such matches are dropped when results arrive (isPodClass), so there is
 *  no "Other" bucket. */
export function typeOfClass(raw: string | null | undefined): { label: string; color: string } | null {
  const c = categoryForClass(raw);
  return c ? { label: c.label, color: c.color } : null;
}

/** True when a match's class belongs to one of the POD tabs. */
export function isPodClass(raw: string | null | undefined): boolean {
  return categoryForClass(raw) !== undefined;
}

/** True if two class lists describe the same tab. */
export function sameClasses(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b.map(normalizeClass));
  return a.every((x) => bs.has(normalizeClass(x)));
}

/** rgba() string from a #rrggbb hex plus alpha. */
export function tint(hex: string, alpha: number): string {
  if (hex === 'transparent') return hex;
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export type TrademarkStatusTone = 'live' | 'pending' | 'dead';

export function trademarkStatusTone(
  registrationStatus: string | null | undefined,
  status: string | null | undefined
): TrademarkStatusTone {
  const reg = (registrationStatus ?? '').toLowerCase();
  const live = (status ?? '').toLowerCase();
  if (reg === 'pending') return 'pending';
  if (reg === 'cancelled' || reg === 'canceled' || reg === 'abandoned' || live === 'dead') return 'dead';
  if (reg === 'registered' || live === 'live') return 'live';
  // Every match is a real filed mark: no recognized status means it is still
  // in the application stage, so treat it as pending (never show "Unknown").
  return 'pending';
}

/** Hard left-to-right split stops for a list of tinted colors (no blending). */
function splitStops(colors: readonly string[], alpha: number): string {
  const n = colors.length;
  return colors
    .map((c, i) => {
      const start = Math.round((i / n) * 100);
      const end = Math.round(((i + 1) / n) * 100);
      const col = tint(c, alpha);
      return `${col} ${start}%, ${col} ${end}%`;
    })
    .join(', ');
}

/**
 * Fill CSS for a highlight given the distinct category colors that flagged it.
 * One color → a flat tint. Two+ → a hard left-to-right split into solid color
 * bands (no gradient blend), so every contributing product type shows as its
 * own segment.
 */
export function highlightBackground(colors: readonly string[], alpha: number): string {
  if (colors.length === 0) return 'transparent';
  if (colors.length === 1) return tint(colors[0], alpha);
  return `linear-gradient(to right, ${splitStops(colors, alpha)})`;
}

/**
 * A hard left-to-right split of solid colors as a `linear-gradient` — always an
 * image, even for a single color — so it can drive a background-image underline.
 * One color → a solid line; two+ → solid colored segments, no blend.
 */
export function splitGradient(colors: readonly string[], alpha: number): string {
  const cs = colors.length ? colors : ['transparent'];
  if (cs.length === 1) {
    const c = tint(cs[0], alpha);
    return `linear-gradient(${c}, ${c})`;
  }
  return `linear-gradient(to right, ${splitStops(cs, alpha)})`;
}
