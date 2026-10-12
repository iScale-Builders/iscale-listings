// iScale Trademark Checker — content script (the page agent).
//
// The UI lives in Chrome's native side panel (sidepanel.html). This script is
// the page-side half: it pulls prominent text, highlights matches in place, and
// watches for text selections. It is driven by the panel over chrome messaging
// and reports results back to it.
//   panel -> here : chrome.tabs.sendMessage(tabId, { type:'cmd', action, ... })
//   here  -> panel: chrome.runtime.sendMessage({ type:'tm-...' })
// All API calls go through the background service worker (avoids MV3 CORS).

import { highlightBackground, isPodClass, splitGradient, trademarkStatusTone, typeOfClass } from '../categories';
import type { TrademarkStatusTone } from '../categories';
import {
  chunkByWords,
  isMerchEditorHost,
  mergeMatches as mergeMatchesInto,
  outermostElements,
  splitLongPhrase,
  splitMatchParts,
  type TextPart,
} from '../scan-core';
import {
  DEFAULT_STATUS_VISIBILITY,
  displayMatches,
  escapeHtml,
  escAttr,
  HIDE_SINGLE_KEY,
  JURISDICTIONS,
  JURISDICTIONS_KEY,
  normalizeJurisdictions,
  trademarkRecordUrl,
  type TrademarkJurisdiction,
  MODE_KEY,
  normalizeStatusVisibility,
  storageGet,
  STATUS_VISIBILITY_KEY,
  tierOf,
  type CheckResponse,
  type ScanMode,
  type StatusVisibility,
  type TrademarkMatch,
  uncheckedJurisdictions,
} from '../shared';

interface BgResult {
  ok: boolean;
  status?: number;
  data?: CheckResponse;
  error?: string;
  retryAfter?: number;
  /** Requested jurisdictions the API did not search (set client-side). */
  unchecked?: string[];
}

// ---------------------------------------------------------------------------
// Config / state
// ---------------------------------------------------------------------------

const CSS = 'itm'; // class/id prefix for everything we inject
const HIGH = '#ea4800';
const LOW = '#f5a623';
const MAX_CANDIDATES = 200; // cap how much of a page we scan in one pass (long blocks now split into pieces)
const MIN_WORD_LEN = 3;

let selectedClasses: string[] = ['025'];
let selectedJurisdictions: TrademarkJurisdiction[] = [...JURISDICTIONS];

// Scan scope. 'any' = the generic, whole-page extraction (works on any site).
// 'amazon' = read only an Amazon listing's brand, title, and bullet points —
// the fields that actually carry trademark risk on a product page — and ignore
// everything else (related products, reviews, nav, ads…).
// 'etsy' = read only Etsy listing cards/titles on the page.
let scanMode: ScanMode = 'any';

// Single-word marks (DESIGN, SHIRT, LOVE…) are the main source of false
// positives, but some matter most (NIKE, GUCCI). Default: keep them but faint;
// the panel toggle can hide them entirely.
let hideSingleWord = true;
let visibleStatuses: StatusVisibility = { ...DEFAULT_STATUS_VISIBILITY };

// Last result set, so the toggle can re-highlight without re-fetching.
let lastMatches: TrademarkMatch[] = [];
let lastStale = false;
// The last scan failed on some chunk(s) → the accumulated results are INCOMPLETE.
// Persisted (not just sent once) so a panel reopen can restore the partial warning
// via the sync handshake instead of silently showing the matches as a clean scan.
let lastPartial = false;
// Set when candidate extraction trims the page (hit the MAX_CANDIDATES cap or
// dropped an over-long element). A trimmed scan didn't cover everything, so it
// must surface as INCOMPLETE rather than a confident clean pass.
let extractTruncated = false;

/**
 * Fold a fresh result set into the accumulated `lastMatches` instead of
 * replacing it, so each product-type scan adds to the page rather than wiping
 * the previous one. Dedupe identity + merge live in scan-core (unit-tested).
 */
function mergeMatches(incoming: readonly TrademarkMatch[], stale: boolean): void {
  if (stale) lastStale = true;
  // Only the POD tab classes are shown; a match in any other class is dropped.
  lastMatches = mergeMatchesInto(lastMatches, incoming.filter((m) => isPodClass(m.international_class)));
}

function root(): Element {
  return document.querySelector('main') ?? document.body;
}

// ---------------------------------------------------------------------------
// Notify the side panel (best-effort; the panel may be closed)
// ---------------------------------------------------------------------------

function notifyPanel(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    /* panel closed / no receiver */
  }
}

// ---------------------------------------------------------------------------
// API (via background)
// ---------------------------------------------------------------------------

// If the MV3 service worker is killed between message dispatch and
// sendResponse, Chrome drops the port WITHOUT invoking our callback — an
// unguarded await here leaves `scanning` stuck true and silently disables
// scanning on this page until reload. Bound the wait so the flag always clears.
const BG_CHECK_TIMEOUT_MS = 30_000;

function checkViaBackground(text: string): Promise<BgResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'No response from the extension — try reloading it.' });
    }, BG_CHECK_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(
        { type: 'check', text, classes: selectedClasses, jurisdictions: selectedJurisdictions },
        (resp: BgResult) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'No response' });
          } else if (resp.ok && resp.data) {
            // A jurisdiction the API skipped was never screened: mark the result
            // unverified so it can't render as a clean "no conflicts".
            const unchecked = uncheckedJurisdictions(resp.data, selectedJurisdictions);
            resolve(unchecked.length ? { ...resp, unchecked, data: { ...resp.data, data_stale: true } } : resp);
          } else {
            resolve(resp);
          }
        }
      );
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e instanceof Error ? e.message : 'Messaging failed' });
    }
  });
}

// ---------------------------------------------------------------------------
// Text extraction (generic, any page)
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SVG', 'CANVAS',
]);

/** Selectors for elements that tend to carry a product/brand name. */
const CANDIDATE_SELECTORS = [
  'h1', 'h2', 'h3', 'h4',
  '[class*="title" i]', '[data-testid*="title" i]',
  '[class*="product" i] a', '[class*="listing" i] a',
  'a[href*="/dp/"]', 'a[href*="/listing/"]',
].join(',');

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (!he.offsetParent && he.offsetHeight === 0 && he.offsetWidth === 0) {
    const r = he.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
  }
  const style = window.getComputedStyle(he);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function isInChrome(el: Element): boolean {
  // A heading inside a <header> is usually the page's own title (Wikipedia,
  // blogs, many shops wrap the H1 in <header>) — only the site banner is chrome.
  const isHeading = /^H[1-4]$/.test(el.tagName);
  let node: Element | null = el;
  while (node) {
    if (SKIP_TAGS.has(node.tagName) && !(isHeading && node.tagName === 'HEADER')) return true;
    const id = (node.id || '') as string;
    const cls = typeof node.className === 'string' ? node.className : '';
    if (id.startsWith(CSS) || cls.includes(`${CSS}-`)) return true;
    node = node.parentElement;
  }
  return false;
}

function hasMeaningfulWord(text: string): boolean {
  return text.split(/\s+/).some((w) => w.replace(/[^a-z0-9]/gi, '').length >= MIN_WORD_LEN);
}

/** Add a cleaned phrase to the candidate set if it's meaningful and new. */
function pushPhrase(out: string[], seen: Set<string>, raw: string): void {
  // A long element is screened in sentence-sized pieces (a brand can live in a
  // long bullet); only a piece that can't be split is dropped, and that gap is
  // recorded so the scan is reported INCOMPLETE.
  const { pieces, dropped } = splitLongPhrase(raw.replace(/\s+/g, ' ').trim());
  if (dropped) extractTruncated = true;
  for (const text of pieces) {
    if (text.length < MIN_WORD_LEN || !hasMeaningfulWord(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
}

/** Collect deduped, prominent candidate phrases from the page (generic mode). */
function extractGenericCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const els = Array.from(root().querySelectorAll(CANDIDATE_SELECTORS));
  for (const el of els) {
    if (out.length >= MAX_CANDIDATES) {
      extractTruncated = true; // more candidates existed than we scanned
      break;
    }
    if (isInChrome(el) || !isVisible(el)) continue;
    pushPhrase(out, seen, el.textContent ?? '');
  }
  return out;
}

// --- Amazon mode -----------------------------------------------------------
// Read only the fields that carry trademark risk, never the surrounding page
// chrome (reviews, nav, filters, payment banners…). Adapts to the
// Amazon surface you're on — the selector groups for the others simply match
// nothing, so we can run them all:
//   • product detail page  — brand byline, #productTitle, #feature-bullets
//   • search results grid  — each tile's brand + title (no bullets exist there)
//   • sponsored carousels  — product-card title/brand text, not the ad label
//   • Seller Central editor — the title / brand / bullet-point input fields

const AMAZON_BRAND_SELECTORS = [
  '#bylineInfo', '#bylineInfo_feature_div a', '#brand',
  'input[name*="brand" i]', 'input[id*="brand" i]',
];
const AMAZON_TITLE_SELECTORS = [
  '#productTitle', '#title #productTitle',
  'input[name*="item_name" i]', 'input[id*="item_name" i]',
  'input[name*="product-title" i]', 'textarea[name*="item_name" i]',
];
const AMAZON_BULLET_SELECTORS = [
  '#feature-bullets li', '#feature-bullets .a-list-item',
  '#featurebullets_feature_div li',
  'textarea[name*="bullet_point" i]', 'input[name*="bullet_point" i]',
  'textarea[id*="bullet" i]',
];
// Search/category grids and sponsored carousels: each product card's brand +
// title. `.a-size-base-plus` carries the brand/title text on many Amazon card
// variants; `h2 span` catches the standard search-card title line.
const AMAZON_SEARCH_SELECTORS = [
  'div[data-component-type="s-search-result"] .a-size-base-plus',
  'div[data-component-type="s-search-result"] h2 span',
  '[data-component-type="sp-sponsored-result"] .a-size-base-plus',
  '[data-component-type="sp-sponsored-result"] h2 span',
  '.a-carousel-card .a-size-base-plus',
  '.a-carousel-card h2 span',
  '[data-asin]:not([data-asin=""]) .a-size-base-plus',
  '[data-asin]:not([data-asin=""]) h2 span',
];
// Tile chrome that shares the title's classes but isn't brand/title text:
// "Amazon's Choice"/"Overall Pick" popovers, "Best Seller" and status badges.
const AMAZON_SKIP_WITHIN =
  '.a-badge, .a-badge-region, .ac-badge-popover, .ac-popover-text, [data-component-type="s-status-badge"]';

/** Read an element's user-visible text, whether it's content or a form field. */
function readFieldText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value ?? '';
  return el.textContent ?? '';
}

/** Strip Amazon byline chrome ("Visit the X Store", "Brand: X") down to the name. */
function cleanBrand(raw: string): string {
  return raw
    .replace(/^\s*Brand:\s*/i, '')
    .replace(/^\s*Visit the\s+/i, '')
    .replace(/\s+Store\s*$/i, '')
    .trim();
}

/** Drop the "Sponsored" tile label so it isn't checked as a phrase. */
function dropSponsored(raw: string): string {
  const t = raw.trim();
  return /^sponsored$/i.test(t) ? '' : t.replace(/^Sponsored\s+/i, '');
}

function collectAmazon(
  selectors: string[],
  out: string[],
  seen: Set<string>,
  transform?: (s: string) => string,
): void {
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (out.length >= MAX_CANDIDATES) return;
      if (isInChrome(el) || !isVisible(el) || el.closest(AMAZON_SKIP_WITHIN)) continue;
      const raw = readFieldText(el);
      pushPhrase(out, seen, transform ? transform(raw) : raw);
    }
  }
}

/** Amazon-only extraction: brand, title, and bullet points — nothing else. */
function extractAmazonCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  collectAmazon(AMAZON_BRAND_SELECTORS, out, seen, cleanBrand);
  collectAmazon(AMAZON_TITLE_SELECTORS, out, seen);
  collectAmazon(AMAZON_BULLET_SELECTORS, out, seen);
  collectAmazon(AMAZON_SEARCH_SELECTORS, out, seen, dropSponsored);
  return out;
}

// --- Etsy mode -------------------------------------------------------------
// Read only listing cards on Etsy search/category/shop pages. Etsy surrounds
// cards with lots of repeated marketplace chrome, so keep extraction anchored
// to listing-card title/link elements and highlight only inside listing cards.

const ETSY_LISTING_SELECTORS = [
  '[data-listing-id]',
  '[data-test-id="listing-card"]',
  '.v2-listing-card',
  'li:has(a[href*="/listing/"])',
];
const MAX_ETSY_CANDIDATES = 36;

const ETSY_CARD_TITLE_SELECTORS = [
  'h3',
  '[data-test-id*="listing-title" i]',
  'a[href*="/listing/"]',
];

// Single-listing DETAIL pages (etsy.com/listing/…) carry no cards — just one
// page title. Without these, a detail-page scan returns "no scannable text".
const ETSY_DETAIL_TITLE_SELECTORS = [
  'h1[data-buy-box-listing-title]',
  'h1[data-test-id="listing-page-title"]',
  '#listing-page-cart h1',
  '[data-component="listing-page-title-component"] h1',
];

const ETSY_SKIP_WITHIN =
  '[data-test-id*="price" i], [data-test-id*="rating" i], [data-test-id*="review" i], .wt-screen-reader-only';

function cleanEtsyListing(raw: string): string {
  return raw
    .replace(/\bAd(?:vertisement)?\b/gi, ' ')
    .replace(/\bStar Seller\b/gi, ' ')
    .replace(/\bBestseller\b/gi, ' ')
    .replace(/\bFree shipping\b/gi, ' ')
    .replace(/\bSale Price\b/gi, ' ')
    .replace(/\bOriginal Price\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function listingCardKey(card: Element): string {
  const listingId = card.getAttribute('data-listing-id');
  if (listingId) return `id:${listingId}`;
  const link = card.querySelector('a[href*="/listing/"]') as HTMLAnchorElement | null;
  return link?.href ? `href:${link.href.split('?')[0]}` : '';
}

function readEtsyCardTitle(card: Element): string {
  for (const sel of ETSY_CARD_TITLE_SELECTORS) {
    const el = card.querySelector(sel);
    if (!el || !isVisible(el) || el.closest(ETSY_SKIP_WITHIN)) continue;
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const raw = aria || title || readFieldText(el);
    const cleaned = cleanEtsyListing(raw);
    if (hasMeaningfulWord(cleaned)) return cleaned;
  }
  return '';
}

function extractEtsyCandidates(): string[] {
  const seen = new Set<string>();
  const seenCards = new Set<string>();
  const out: string[] = [];
  for (const sel of ETSY_LISTING_SELECTORS) {
    for (const card of Array.from(document.querySelectorAll(sel))) {
      if (out.length >= MAX_ETSY_CANDIDATES) return out;
      if (isInChrome(card) || !isVisible(card)) continue;
      const key = listingCardKey(card);
      if (key && seenCards.has(key)) continue;
      if (key) seenCards.add(key);
      pushPhrase(out, seen, readEtsyCardTitle(card));
    }
  }
  // No cards (a single-listing detail page) → fall back to the page title.
  if (out.length === 0) {
    for (const sel of ETSY_DETAIL_TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) pushPhrase(out, seen, cleanEtsyListing(readFieldText(el)));
    }
  }
  return out;
}

/** Collect candidate phrases according to the active scan mode. */
function extractCandidates(): string[] {
  extractTruncated = false;
  if (scanMode === 'amazon') return extractAmazonCandidates();
  if (scanMode === 'etsy') return extractEtsyCandidates();
  return extractGenericCandidates();
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/** Wrap every WHOLE-WORD occurrence of `needleText` under `scope`, one bare
 *  <mark> per word (spaces between words stay unpainted) — splitMatchParts
 *  enforces word boundaries so a mark like CAT doesn't paint inside "category".
 *  A word already wrapped by a longer phrase is reused, not nested, so one word
 *  carries every mark that touches it. The caller colors the returned marks. */
function wrapText(scope: Element, needleText: string): HTMLElement[] {
  const needle = needleText.toLowerCase();
  if (needle.length < MIN_WORD_LEN) return [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; parts: TextPart[] }[] = [];
  const reused: HTMLElement[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const t = node as Text;
    const parent = t.parentElement;
    if (parent && !isInChrome(parent)) {
      const parts = splitMatchParts(t.data, needle);
      if (parts?.length === 1 && parts[0].isMatch && parent.matches(`mark.${CSS}-hl`)) reused.push(parent);
      else if (parts) targets.push({ node: t, parts });
    }
    node = walker.nextNode();
  }

  const marks: HTMLElement[] = [];
  for (const { node: t, parts } of targets) {
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.isMatch) {
        for (const piece of part.text.split(/(\s+)/)) {
          if (!piece) continue;
          if (/^\s+$/.test(piece)) {
            frag.appendChild(document.createTextNode(piece));
            continue;
          }
          const mark = document.createElement('mark');
          mark.className = `${CSS}-hl`;
          mark.textContent = piece;
          marks.push(mark);
          frag.appendChild(mark);
        }
      } else {
        frag.appendChild(document.createTextNode(part.text));
      }
    }
    t.parentNode?.replaceChild(frag, t);
  }
  return [...reused, ...marks];
}

function clearHighlights(): void {
  for (const mark of Array.from(document.querySelectorAll(`mark.${CSS}-hl`))) {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    }
  }
}

// Highlight opacity by confidence tier — applied to the category color(s).
const CAT_ALPHA: Record<'high' | 'low' | 'faint', number> = { high: 0.6, low: 0.45, faint: 0.3 };

const STATUS_RANK = { live: 3, pending: 2, dead: 0 } as const;

interface Segment {
  readonly color: string;
  readonly tone: TrademarkStatusTone;
}

/** One segment per product type (its strongest status), in first-seen order, so
 *  a split only ever shows different product types — never shades of one type. */
function segmentsOf(ms: readonly TrademarkMatch[]): Segment[] {
  const best = new Map<string, TrademarkMatch>();
  const rank = (x: TrademarkMatch) => STATUS_RANK[trademarkStatusTone(x.registration_status, x.status)];
  for (const m of ms) {
    const t = typeOfClass(m.international_class);
    if (!t) continue;
    const cur = best.get(t.label);
    if (!cur || rank(m) > rank(cur)) best.set(t.label, m);
  }
  return [...best.values()].map((m) => ({
    color: typeOfClass(m.international_class)?.color ?? 'transparent',
    tone: trademarkStatusTone(m.registration_status, m.status),
  }));
}

function visibleStatusMatches(matches: readonly TrademarkMatch[]): TrademarkMatch[] {
  return matches.filter((m) => visibleStatuses[trademarkStatusTone(m.registration_status, m.status)]);
}

function groupHasLive(ms: readonly TrademarkMatch[]): boolean {
  return ms.some((m) => trademarkStatusTone(m.registration_status, m.status) === 'live');
}

/** Strongest tier in a group: high > low > faint. */
function groupTier(ms: readonly TrademarkMatch[]): 'high' | 'low' | 'faint' {
  let best: 'high' | 'low' | 'faint' = 'faint';
  for (const m of ms) {
    const t = tierOf(m);
    if (t === 'high') return 'high';
    if (t === 'low') best = 'low';
  }
  return best;
}

// The on-page regions Amazon mode is allowed to highlight inside — the same
// places it reads from. Each is disjoint from the others (and search tiles only
// exist on a results page, detail sections only on a detail page), so there's no
// nesting. Anything outside these — the left filter/shipping rail, top nav,
// departments, pagination — is never touched, even if it repeats a flagged word.
const AMAZON_HIGHLIGHT_SCOPES = [
  'div[data-component-type="s-search-result"]', // search / category grid tiles
  '[data-component-type="sp-sponsored-result"]', // sponsored result widgets
  '.a-carousel-card',                            // sponsored carousel cards
  '[data-asin]:not([data-asin=""])',             // other Amazon product cards
  '#productTitle',                               // detail title
  '#bylineInfo',                                 // detail brand byline
  '#feature-bullets',                            // detail bullets
];

const ETSY_HIGHLIGHT_SCOPES = [...ETSY_LISTING_SELECTORS, ...ETSY_DETAIL_TITLE_SELECTORS];

/** Regions to highlight within. Whole page in 'any' mode; only the scanned
 *  marketplace regions in marketplace modes (empty if none are present). */
function highlightScopes(): Element[] {
  const sels = scanMode === 'amazon' ? AMAZON_HIGHLIGHT_SCOPES : scanMode === 'etsy' ? ETSY_HIGHLIGHT_SCOPES : null;
  if (!sels) return [root()];
  // One query (document order, no duplicates), then only the outermost regions,
  // so a card that matches several selectors is walked once, not 3-4 times.
  return outermostElements(Array.from(document.querySelectorAll(sels.join(', '))));
}

/**
 * Re-paint every highlight from the accumulated set, one <mark> per word.
 * A word collects every mark that touches it (a phrase, a single word, or both);
 * hovering or clicking it lists them all. Encoding, per word:
 *   • any multi-word / strong mark → a solid color fill
 *   • only noisy single-word marks → a 3px underline, no fill
 *   • color = product type; two+ types → hard left-to-right split (no blend)
 *   • live    → the plain neon color
 *   • pending → the same solid fill as live PLUS an outer dotted border
 *   • dead    → a strikethrough in its product color, no fill
 */
function applyHighlights(): void {
  clearHighlights();
  removePopup();
  const shown = visibleStatusMatches(displayMatches(lastMatches, hideSingleWord));
  const groups = new Map<string, TrademarkMatch[]>();
  for (const m of shown) {
    const key = m.matched_text.toLowerCase();
    if (key.length < MIN_WORD_LEN) continue;
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }

  // Each scope's text, read once: a phrase can only be wrapped where it appears
  // verbatim inside one text node, so a scope whose text lacks it is skipped
  // without walking its DOM (most cards contain only a few flagged phrases).
  const scopes = highlightScopes().map((el) => ({ el, text: (el.textContent ?? '').toLowerCase() }));
  const byMark = new Map<HTMLElement, TrademarkMatch[]>();
  const ordered = [...groups.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [key, ms] of ordered) {
    // Shorter phrases inside this one (e.g. "do it" in "just do it") ride along
    // in its words' popups, since their own occurrence is already split up.
    const inner = ordered.filter(([k]) => k !== key && splitMatchParts(key, k));
    for (const scope of scopes) {
      if (!scope.text.includes(key)) continue;
      for (const mark of wrapText(scope.el, ms[0].matched_text)) {
        const word = (mark.textContent ?? '').toLowerCase();
        const own = inner.filter(([k]) => k.split(/\s+/).includes(word)).flatMap(([, g]) => g);
        const list = byMark.get(mark) ?? [];
        for (const m of [...ms, ...own]) if (!list.includes(m)) list.push(m);
        byMark.set(mark, list);
      }
    }
  }

  for (const [mark, ms] of byMark) paintMark(mark, ms);
}

function paintMark(mark: HTMLElement, ms: readonly TrademarkMatch[]): void {
  const segments = segmentsOf(ms);
  const colors = segments.map((g) => (g.tone === 'dead' ? 'transparent' : g.color));
  const pendingColor = segments.find((g) => g.tone === 'pending')?.color;
  const deadColor = segments.find((g) => g.tone === 'dead')?.color;
  const tier = groupTier(ms);
  if (tier === 'faint') {
    // Underline only, painted as a background-image so multiple classes split
    // into solid segments.
    mark.style.background = 'none';
    mark.style.backgroundRepeat = 'no-repeat';
    if (pendingColor) {
      // Pending single word: the same fill as the legend, sitting ABOVE the
      // underline with a 3px gap, so fill, underline and the outer dotted
      // border all show at once.
      mark.style.backgroundImage = `${splitGradient(colors, 1)}, ${splitGradient(colors, CAT_ALPHA.high)}`;
      mark.style.backgroundSize = '100% 3px, 100% calc(100% - 6px)';
      mark.style.backgroundPosition = 'left bottom, left top';
    } else {
      mark.style.backgroundImage = splitGradient(colors, 1);
      mark.style.backgroundSize = '100% 3px';
      mark.style.backgroundPosition = 'left bottom';
    }
    mark.style.mixBlendMode = 'normal'; // keep the line color true
  } else {
    mark.style.background = highlightBackground(colors, CAT_ALPHA[tier]);
  }
  // The thin dark edge only frames a filled live highlight; on an underline-only
  // single word it would draw a grey box around the word.
  mark.style.boxShadow = tier !== 'faint' && groupHasLive(ms) ? 'inset 0 0 0 1px rgba(0,0,0,.38)' : 'none';
  mark.style.outline = pendingColor ? `2px dotted ${pendingColor}` : 'none';
  mark.style.outlineOffset = pendingColor ? '2px' : '0';
  mark.style.textDecoration = deadColor ? `line-through 2px ${deadColor}` : 'none';
  mark.style.cursor = 'pointer';
  mark.setAttribute(`data-${CSS}-serials`, Array.from(new Set(ms.map((m) => m.serial_number))).join(','));
  mark.addEventListener('mouseenter', () => showGroupPopup(ms, mark));
  mark.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showGroupPopup(ms, mark);
  });
}

/** Re-apply highlights from the cached result set (used by the hide toggle). */
function rehighlight(): void {
  applyHighlights();
}

function focusSerial(serial: string): void {
  const marks = Array.from(document.querySelectorAll(`mark.${CSS}-hl`)) as HTMLElement[];
  const mark = marks.find((mk) => (mk.getAttribute(`data-${CSS}-serials`) ?? '').split(',').includes(serial));
  if (!mark) return;
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = mark.style.outline;
  mark.style.outline = `2px solid ${HIGH}`;
  setTimeout(() => (mark.style.outline = prev), 1500);
}

// ---------------------------------------------------------------------------
// In-page popup (clicking a highlight shows its detail without the panel)
// ---------------------------------------------------------------------------

let activePopup: HTMLElement | null = null;
let activePopupAnchor: HTMLElement | null = null;

function removePopup(): void {
  activePopup?.remove();
  activePopup = null;
  activePopupAnchor = null;
}

function prow(label: string, value: string): string {
  return `<div class="${CSS}-prow"><span class="${CSS}-plabel">${label}</span><span>${value}</span></div>`;
}

function showGroupPopup(matches: readonly TrademarkMatch[], anchor: HTMLElement): void {
  if (activePopup && activePopupAnchor === anchor) return;
  removePopup();
  const popup = document.createElement('div');
  popup.className = `${CSS}-popup`;
  const items = matches
    .map((match) => {
      const t = typeOfClass(match.international_class);
      if (!t) return '';
      const color = t.color;
      const dead = trademarkStatusTone(match.registration_status, match.status) === 'dead';
      const conf = match.confidence === 'high' ? 'High' : 'Low';
      const jur = match.jurisdiction ?? 'US';
      return `<div class="${CSS}-pitem">
        <div class="${CSS}-pwm"><span class="${CSS}-cdot" style="background:${color}"></span><strong${dead ? ' style="text-decoration:line-through"' : ''}>${escapeHtml(match.wordmark)}</strong></div>
        ${prow('Matched', escapeHtml(match.matched_text))}
        ${prow('Type', escapeHtml(t.label))}
        ${prow('Registry', escapeHtml(jur))}
        ${prow('Class', escapeHtml(match.international_class))}
        ${match.owner ? prow('Owner', escapeHtml(match.owner)) : ''}
        ${prow('Status', escapeHtml(match.registration_status ?? match.status))}
        ${prow('Serial', `<a href="${escAttr(trademarkRecordUrl(match))}" target="_blank" rel="noopener noreferrer">${escapeHtml(match.serial_number)}</a>`)}
        ${prow('Confidence', `<span class="${CSS}-dot ${CSS}-dot-${escAttr(String(match.confidence))}"></span> ${conf}`)}
      </div>`;
    })
    .join('');
  popup.innerHTML = `
    <div class="${CSS}-phead">
      <strong>${escapeHtml(anchor.textContent ?? matches[0].matched_text)}</strong>
      <span class="${CSS}-pcount">${matches.length} mark${matches.length === 1 ? '' : 's'}</span>
      <button class="${CSS}-pclose" aria-label="Close">&times;</button>
    </div>
    <div class="${CSS}-pbody">${items}</div>`;
  const r = anchor.getBoundingClientRect();
  popup.style.position = 'absolute';
  popup.style.top = `${window.scrollY + r.bottom + 6}px`;
  popup.style.left = `${window.scrollX + r.left}px`;
  popup.style.zIndex = '2147483647';
  popup.querySelector(`.${CSS}-pclose`)?.addEventListener('click', (e) => {
    e.stopPropagation();
    removePopup();
  });
  document.body.appendChild(popup);
  activePopup = popup;
  activePopupAnchor = anchor;
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) popup.style.left = `${window.innerWidth - pr.width - 8}px`;
  });
}

document.addEventListener('click', (e) => {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    if (!(e.target as HTMLElement).closest?.(`mark.${CSS}-hl`)) removePopup();
  }
});

// ---------------------------------------------------------------------------
// Mode 1 — scan the whole page
// ---------------------------------------------------------------------------

let scanning = false;

async function scanPage(): Promise<void> {
  if (scanning) return;
  scanning = true;
  removePopup();

  const phrases = extractCandidates();
  if (phrases.length === 0) {
    notifyPanel({ type: 'tm-error', kind: 'empty', mode: scanMode });
    scanning = false;
    return;
  }
  const chunks = chunkByWords(phrases);
  const all: TrademarkMatch[] = [];
  let stale = false;
  let coverageGap = false;
  let errored = false;
  let errStatus: number | undefined;
  let errMsg: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    notifyPanel({ type: 'tm-progress', i: i + 1, n: chunks.length });
    const res = await checkViaBackground(chunks[i]);
    // A batch that expands into too many phrase candidates for one request
    // (pluralizable words multiply them) is split in half and retried, so a
    // dense page is checked in smaller pieces instead of failing.
    if (!res.ok && res.status === 400 && /exceeding|candidates/i.test(res.error ?? '')) {
      const lines = chunks[i].split('\n');
      const words = chunks[i].split(/\s+/).length;
      const halves = lines.length > 1
        ? chunkByWords(lines, Math.max(1, Math.ceil(words / 2)))
        : chunkByWords(chunks[i].split(' ').reduce<string[]>((acc, w, j) => {
            if (j % 20 === 0) acc.push(w);
            else acc[acc.length - 1] += ` ${w}`;
            return acc;
          }, []), 20);
      if (halves.length > 1) {
        chunks.splice(i, 1, ...halves);
        i--;
        continue;
      }
    }
    if (res.ok && res.data) {
      all.push(...res.data.matches);
      if (res.data.data_stale) stale = true;
      if (res.unchecked?.length) coverageGap = true;
      continue;
    }
    if (res.status === 429 && all.length === 0) {
      notifyPanel({ type: 'tm-error', kind: 'rate', retryAfter: res.retryAfter });
      scanning = false;
      return;
    }
    errored = true;
    errStatus = res.status;
    errMsg = res.error;
    // 403 is the anonymous-class gate: every chunk fails identically, so stop.
    // A 429 mid-scan would fail the remaining chunks the same way — but keep
    // the matches already collected and show them flagged INCOMPLETE rather
    // than throwing them away.
    if (res.status === 403 || res.status === 429) break;
  }

  if (!errored) {
    mergeMatches(all, stale);
    // Every chunk was checked, but if extraction trimmed the page the scan still
    // didn't cover everything — surface that as INCOMPLETE, not a clean pass.
    // A skipped jurisdiction is also incomplete coverage.
    lastPartial = extractTruncated || coverageGap;
    applyHighlights();
    notifyPanel({ type: 'tm-results', matches: lastMatches, stale: lastStale, partial: lastPartial });
  } else if (all.length > 0) {
    // Partial: some chunks failed but we got matches. Show them flagged as an
    // INCOMPLETE scan — never as a clean result that could read as "all clear".
    mergeMatches(all, stale);
    lastPartial = true;
    applyHighlights();
    notifyPanel({ type: 'tm-results', matches: lastMatches, stale: lastStale, partial: true });
  } else if (errStatus === 403) {
    notifyPanel({ type: 'tm-error', kind: 'forbidden', message: errMsg });
  } else {
    notifyPanel({ type: 'tm-error', kind: 'fail', message: errMsg ?? "Couldn't complete the scan." });
  }
  scanning = false;
}

// ---------------------------------------------------------------------------
// Mode 2 — selection
// ---------------------------------------------------------------------------

let selBtn: HTMLElement | null = null;

function removeSelBtn(): void {
  selBtn?.remove();
  selBtn = null;
}

function currentSelectionText(): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (text.length < MIN_WORD_LEN || text.length > 200 || !hasMeaningfulWord(text)) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return { text, rect };
}

document.addEventListener('mouseup', (e) => {
  if ((e.target as HTMLElement)?.closest?.(`[id^="${CSS}"], .${CSS}-popup, .${CSS}-selbtn, .${CSS}-toast`)) return;
  setTimeout(() => {
    const sel = currentSelectionText();
    removeSelBtn();
    if (!sel) return;
    const btn = document.createElement('button');
    btn.className = `${CSS}-selbtn`;
    btn.textContent = '™ Check';
    btn.style.position = 'absolute';
    btn.style.top = `${window.scrollY + sel.rect.bottom + 6}px`;
    btn.style.left = `${window.scrollX + sel.rect.left}px`;
    btn.style.zIndex = '2147483647';
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void checkSelection(sel.text, sel.rect);
      removeSelBtn();
    });
    document.body.appendChild(btn);
    selBtn = btn;
  }, 10);
});

document.addEventListener('scroll', () => removeSelBtn(), { passive: true });

function truncSel(s: string): string {
  return s.length > 32 ? s.slice(0, 32) + '…' : s;
}

/** Current selection's bounding rect, or null if collapsed/absent. */
function selectionRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  return sel.getRangeAt(0).getBoundingClientRect();
}

/** Page coords to anchor the result toast — just below the selection, or
 *  top-center of the viewport when there's no usable rect. */
function toastAnchor(rect: DOMRect | null): { top: number; left: number } {
  if (rect && (rect.width || rect.height)) {
    return { top: window.scrollY + rect.bottom + 6, left: window.scrollX + rect.left };
  }
  return { top: window.scrollY + 14, left: window.scrollX + Math.max(8, window.innerWidth / 2 - 130) };
}

/** A small auto-dismissing on-page toast so the selection check gives feedback
 *  even when the side panel is closed (its only other feedback channel). */
function showToast(message: string, kind: 'ok' | 'warn' | 'err', pos: { top: number; left: number }): void {
  document.querySelector(`.${CSS}-toast`)?.remove();
  const t = document.createElement('div');
  t.className = `${CSS}-toast`;
  const bg = kind === 'ok' ? '#1c7a43' : kind === 'warn' ? '#b42318' : '#444';
  t.style.cssText =
    `position:absolute;z-index:2147483647;top:${pos.top}px;left:${pos.left}px;max-width:300px;` +
    `background:${bg};color:#fff;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
    `padding:7px 11px;border-radius:7px;box-shadow:0 3px 12px rgba(0,0,0,.28)`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => {
    const r = t.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) t.style.left = `${window.scrollX + window.innerWidth - r.width - 8}px`;
  });
  setTimeout(() => t.remove(), 4500);
}

async function checkSelection(text: string, rect?: DOMRect): Promise<void> {
  removePopup();
  const pos = toastAnchor(rect ?? selectionRect());
  notifyPanel({ type: 'tm-checking', text });
  const res = await checkViaBackground(text);
  if (res.ok && res.data) {
    mergeMatches(res.data.matches, res.data.data_stale ?? false);
    applyHighlights();
    notifyPanel({ type: 'tm-results', matches: lastMatches, stale: lastStale });
    const marks = [...new Set(res.data.matches.map((m) => m.wordmark))];
    const stale = res.data.data_stale === true;
    showToast(
      marks.length
        ? marks.length <= 2
          ? `⚠ Possible trademark: ${marks.join(', ')}`
          : `⚠ ${marks.length} possible trademarks for “${truncSel(text)}”`
        : res.unchecked?.length
          ? `⚠ Not checked in ${res.unchecked.join(', ')} — “${truncSel(text)}” is UNVERIFIED, not clear.`
          : stale
          ? `⚠ DB updating — couldn't fully verify “${truncSel(text)}”. Re-check.`
          : `✓ No trademark conflict for “${truncSel(text)}”`,
      marks.length || stale ? 'warn' : 'ok',
      pos
    );
  } else if (res.status === 429) {
    notifyPanel({ type: 'tm-error', kind: 'rate', retryAfter: res.retryAfter });
    showToast(`Rate limited — wait ${res.retryAfter ?? 30}s and check again`, 'err', pos);
  } else if (res.status === 403) {
    notifyPanel({ type: 'tm-error', kind: 'forbidden', message: res.error });
    showToast('Trademark check not allowed here', 'err', pos);
  } else {
    notifyPanel({ type: 'tm-error', kind: 'fail', message: res.error ?? 'Unknown error' });
    showToast(`Couldn't check “${truncSel(text)}” — try again`, 'err', pos);
  }
}

// ---------------------------------------------------------------------------
// Uploaded-design capture — grab the artwork the user hands to a page (Amazon
// Merch's upload step is the target, but it works anywhere) so the Keywords tab
// can run vision on the EXACT file without a second manual pick.
//
// We capture at the source: any image File chosen through a file input or
// dropped onto the page is read once and stashed as a data URL. `grab-design`
// returns that stash, or — if we never saw the upload (e.g. the page loaded
// before this agent did) — falls back to the largest uploaded raster already
// rendered on the page (Merch shows the art as a blob: <img>/canvas preview).
// ---------------------------------------------------------------------------

let lastUploadedDesign: string | null = null;

// Only capture uploads on marketplace pages where the "Use the design on this
// page" flow is actually used (Amazon/Merch, Etsy). Everywhere else — tax
// portals, medical forms, photo services — we never read the user's uploads into
// extension memory. Checked at event time so SPA host changes are respected.
// Anchored precisely: `amazon.<tld>` / `amazon.<tld>.<cc>` (amazon.com,
// amazon.co.uk, amazon.com.mx…) and `etsy.com`, each with optional subdomains.
// A loose `amazon\.[a-z.]+$` would also match attacker suffixes like
// `amazon.com.evil.com` — the TLD tail here is bounded so it can't.
const UPLOAD_CAPTURE_HOSTS = /(^|\.)(amazon\.[a-z]{2,3}(\.[a-z]{2})?|etsy\.com)$/i;
function uploadCaptureAllowed(): boolean {
  try {
    return UPLOAD_CAPTURE_HOSTS.test(location.hostname);
  } catch {
    return false;
  }
}

// Captured uploads are read into memory as data URLs and later sent to the
// vision model — cap the size so a giant drop doesn't bloat the renderer.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function stashImageFile(file: File | null | undefined): void {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast('Image too large to capture (15 MB max) — downscale it and try again', 'warn', { top: 24, left: 24 });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    lastUploadedDesign = String(reader.result);
  };
  reader.readAsDataURL(file);
}

// Capture phase so we see the file even if the page stops propagation. Cheap:
// fires only on real file picks / drops on a marketplace page, and we read only
// image/* files.
document.addEventListener(
  'change',
  (e) => {
    if (!uploadCaptureAllowed()) return;
    const t = e.target as HTMLInputElement | null;
    if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files) {
      for (const f of Array.from(t.files)) {
        if (f.type.startsWith('image/')) {
          stashImageFile(f);
          break;
        }
      }
    }
  },
  true
);
document.addEventListener(
  'drop',
  (e) => {
    if (!uploadCaptureAllowed()) return;
    const files = (e as DragEvent).dataTransfer?.files;
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) {
        stashImageFile(f);
        break;
      }
    }
  },
  true
);

/** Paint an already-rendered <img>/<canvas> to a PNG data URL (best-effort).
 *  Returns null if it has no pixels yet or the canvas is cross-origin-tainted. */
function rasterToDataUrl(el: HTMLImageElement | HTMLCanvasElement): string | null {
  try {
    if (el instanceof HTMLCanvasElement) {
      if (el.width < 64 || el.height < 64) return null;
      return el.toDataURL('image/png');
    }
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (w < 64 || h < 64) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0);
    return c.toDataURL('image/png'); // throws on a cross-origin-tainted source
  } catch {
    return null;
  }
}

function looksDecorativeImage(im: HTMLImageElement): boolean {
  const haystack = [
    im.alt,
    im.title,
    im.className,
    im.id,
    im.currentSrc || im.src,
  ].join(' ').toLowerCase();
  return /\b(flag|logo|icon|sprite|avatar|badge|country|language|nav|header|footer)\b/.test(haystack);
}

/** Best guess at the uploaded design already on the page. Only local preview
 *  images are accepted here: user uploads normally render as blob:/data: URLs,
 *  while ordinary marketplace/product/decorative HTTP images are too easy to
 *  confuse with the design. Canvas previews are still allowed as a fallback. */
function findDesignOnPage(): string | null {
  const isLocal = (im: HTMLImageElement) => /^(blob:|data:)/.test(im.currentSrc || im.src);
  const imgs = (Array.from(document.images) as HTMLImageElement[])
    .filter((im) => im.naturalWidth >= 64 && im.naturalHeight >= 64)
    .filter(isLocal)
    .filter((im) => !looksDecorativeImage(im))
    .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
  for (const im of imgs) {
    const d = rasterToDataUrl(im);
    if (d) return d;
  }
  const canvases = (Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]).sort(
    (a, b) => b.width * b.height - a.width * a.height
  );
  for (const c of canvases) {
    const d = rasterToDataUrl(c);
    if (d) return d;
  }
  return null;
}

/** Answer the panel's 'grab-design' request. Captured upload wins; else scan. */
function grabDesign(): { ok: boolean; dataUrl?: string; source?: 'upload' | 'page' } {
  if (lastUploadedDesign) return { ok: true, dataUrl: lastUploadedDesign, source: 'upload' };
  const d = findDesignOnPage();
  return d ? { ok: true, dataUrl: d, source: 'page' } : { ok: false };
}

// ---------------------------------------------------------------------------
// Merch by Amazon — detect the listing editor and autofill its fields.
// Selectors match a production Merch upload filler. The
// editor is a React app, so a plain `.value =` is ignored — we set the value
// through the native setter and fire `input`/`change` so React's state updates.
// ---------------------------------------------------------------------------

const MERCH_FIELD_SELECTORS = {
  title: [
    '#designCreator-productEditor-title',
    '[name="title"]',
    'input[id*="productEditor"][id*="title" i]',
    'textarea[id*="productEditor"][id*="title" i]',
    'input[aria-label*="title" i]',
    'textarea[aria-label*="title" i]',
  ],
  brand: [
    '#designCreator-productEditor-brandName',
    '[name="brandName"]',
    '[name="brand"]',
    'input[id*="brand" i]',
    'textarea[id*="brand" i]',
    'input[aria-label*="brand" i]',
    'textarea[aria-label*="brand" i]',
  ],
  bullet1: [
    '#designCreator-productEditor-featureBullet1',
    '[name="featureBullet1"]',
    '[name="bullet1"]',
    'textarea[id*="featureBullet1" i]',
    'textarea[id*="bullet1" i]',
    'textarea[aria-label*="bullet 1" i]',
    'textarea[aria-label*="bullet point 1" i]',
  ],
  bullet2: [
    '#designCreator-productEditor-featureBullet2',
    '[name="featureBullet2"]',
    '[name="bullet2"]',
    'textarea[id*="featureBullet2" i]',
    'textarea[id*="bullet2" i]',
    'textarea[aria-label*="bullet 2" i]',
    'textarea[aria-label*="bullet point 2" i]',
  ],
  description: [
    '#designCreator-productEditor-description',
    '[name="description"]',
    'textarea[id*="description" i]',
    'textarea[aria-label*="description" i]',
  ],
} as const;

type MerchFieldKey = keyof typeof MERCH_FIELD_SELECTORS;

function findMerchField(key: MerchFieldKey): HTMLInputElement | HTMLTextAreaElement | null {
  for (const selector of MERCH_FIELD_SELECTORS[key]) {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) return el;
  }
  return null;
}

/** True when the Merch product-listing editor is on the page. Host-gated to
 *  merch.amazon.* — the field selectors are deliberately loose (they cover
 *  multiple editor generations), so without this they'd match, and
 *  `fill-listing` would write into, any page with a title/brand input. */
function isMerchEditor(): boolean {
  try {
    if (!isMerchEditorHost(location.hostname)) return false;
  } catch {
    return false;
  }
  return !!(findMerchField('title') || findMerchField('brand') || findMerchField('bullet1') || findMerchField('bullet2'));
}

/** Set a React-controlled input/textarea so the framework picks up the change. */
function setReactValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Fill the Merch listing fields from the panel's values. Skips blanks/missing
 *  inputs and reports which keys actually landed so the panel can confirm. */
function fillMerchListing(values: Partial<Record<MerchFieldKey, string>>): {
  ok: boolean;
  filled: MerchFieldKey[];
  missing: MerchFieldKey[];
} {
  if (!isMerchEditor()) return { ok: false, filled: [], missing: [] };
  const filled: MerchFieldKey[] = [];
  const missing: MerchFieldKey[] = [];
  for (const key of Object.keys(MERCH_FIELD_SELECTORS) as MerchFieldKey[]) {
    const value = values[key];
    if (value == null || value === '') continue;
    const el = findMerchField(key);
    if (!el) {
      missing.push(key);
      continue;
    }
    el.focus();
    setReactValue(el, value);
    el.blur();
    filled.push(key);
  }
  return { ok: filled.length > 0, filled, missing };
}

// ---------------------------------------------------------------------------
// Commands from the side panel (relayed via chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: any, _sender: unknown, sendResponse: (r?: unknown) => void) => {
    if (!msg || msg.type !== 'cmd') return undefined;
    switch (msg.action) {
      case 'sync': {
        if (Array.isArray(msg.classes)) selectedClasses = msg.classes;
        if (Array.isArray(msg.jurisdictions)) selectedJurisdictions = normalizeJurisdictions(msg.jurisdictions);
        if (typeof msg.hideSingle === 'boolean') hideSingleWord = msg.hideSingle;
        if (msg.statuses) visibleStatuses = normalizeStatusVisibility(msg.statuses);
        if (msg.mode === 'any' || msg.mode === 'amazon' || msg.mode === 'etsy') scanMode = msg.mode;
        sendResponse({ matches: lastMatches, stale: lastStale, partial: lastPartial });
        return true;
      }
      case 'config': {
        if (Array.isArray(msg.classes)) selectedClasses = msg.classes;
        if (Array.isArray(msg.jurisdictions)) selectedJurisdictions = normalizeJurisdictions(msg.jurisdictions);
        if (msg.mode === 'any' || msg.mode === 'amazon' || msg.mode === 'etsy') scanMode = msg.mode;
        if (msg.statuses) visibleStatuses = normalizeStatusVisibility(msg.statuses);
        if (typeof msg.hideSingle === 'boolean' && msg.hideSingle !== hideSingleWord) {
          hideSingleWord = msg.hideSingle;
        }
        rehighlight();
        break;
      }
      case 'scan': {
        if (Array.isArray(msg.classes)) selectedClasses = msg.classes;
        if (Array.isArray(msg.jurisdictions)) selectedJurisdictions = normalizeJurisdictions(msg.jurisdictions);
        if (typeof msg.hideSingle === 'boolean') hideSingleWord = msg.hideSingle;
        if (msg.statuses) visibleStatuses = normalizeStatusVisibility(msg.statuses);
        if (msg.mode === 'any' || msg.mode === 'amazon' || msg.mode === 'etsy') scanMode = msg.mode;
        void scanPage();
        break;
      }
      case 'rehighlight': {
        if (typeof msg.hideSingle === 'boolean') hideSingleWord = msg.hideSingle;
        if (msg.statuses) visibleStatuses = normalizeStatusVisibility(msg.statuses);
        rehighlight();
        break;
      }
      case 'check-selection': {
        if (typeof msg.text === 'string') void checkSelection(msg.text);
        break;
      }
      case 'grab-design': {
        sendResponse(grabDesign());
        return true;
      }
      case 'merch-detect': {
        sendResponse({ merch: isMerchEditor() });
        return true;
      }
      case 'fill-listing': {
        sendResponse(fillMerchListing(msg.values ?? {}));
        return true;
      }
      case 'focus': {
        if (typeof msg.serial === 'string') focusSerial(msg.serial);
        break;
      }
      case 'clear': {
        clearHighlights();
        removePopup();
        lastMatches = [];
        lastStale = false;
        lastPartial = false;
        break;
      }
      default:
        break;
    }
    return undefined;
  }
);

// ---------------------------------------------------------------------------
// SPA-navigation reset
//
// On sites that swap pages via the History API (Amazon search -> product, most
// React/Next apps) the content script is NOT reloaded, so `lastMatches` would
// keep accumulating and old highlights would linger / mis-position on the new
// page — a later scan then re-reports trademarks from a page the user already
// left. When the URL changes, wipe the page-side match + highlight state so each
// page starts clean. (The panel keeps its last result until the user rescans.)
//
// `popstate` only fires for back/forward; pushState/replaceState happen in the
// PAGE's JS world, which a content script can't hook across the isolated-world
// boundary, so we also poll location.href. The poll is a cheap string compare.
// ---------------------------------------------------------------------------

let lastHref = location.href;
function onMaybeNavigation(): void {
  if (location.href === lastHref) return;
  lastHref = location.href;
  clearHighlights();
  lastMatches = [];
  lastStale = false;
  lastPartial = false;
  removeSelBtn();
}
window.addEventListener('popstate', onMaybeNavigation);
setInterval(onMaybeNavigation, 1000);

// ---------------------------------------------------------------------------
// Styles (page-side only: highlights, popup, selection button)
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById(`${CSS}-styles`)) return;
  const s = document.createElement('style');
  s.id = `${CSS}-styles`;
  s.textContent = `
    mark.${CSS}-hl{border-radius:2px;padding:0 2px;mix-blend-mode:multiply;color:inherit}
    .${CSS}-selbtn{background:${HIGH};color:#fff;border:none;border-radius:6px;padding:5px 10px;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}
    .${CSS}-popup{position:absolute;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);width:280px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;overflow:hidden;z-index:2147483647}
    .${CSS}-phead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#fafafa;border-bottom:1px solid #eee}
    .${CSS}-phead strong{color:${HIGH}}
    .${CSS}-pcount{margin-left:auto;font-size:11px;color:#999}
    .${CSS}-pclose{background:none;border:none;font-size:20px;cursor:pointer;color:#999;line-height:1;padding:0 4px}
    .${CSS}-pclose:hover{color:#333}
    .${CSS}-pbody{padding:4px 14px 10px;max-height:340px;overflow-y:auto}
    .${CSS}-pitem{padding:8px 0;border-top:1px solid #eee}
    .${CSS}-pitem:first-child{border-top:none}
    .${CSS}-pwm{display:flex;align-items:center;gap:6px;margin:2px 0 4px}
    .${CSS}-cdot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto}
    .${CSS}-prow{display:flex;gap:8px;padding:3px 0;line-height:1.5}
    .${CSS}-plabel{color:#888;min-width:72px;font-size:12px}
    .${CSS}-pbody a{color:${HIGH};text-decoration:none}
    .${CSS}-dot{display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle}
    .${CSS}-dot-high{background:${HIGH}}.${CSS}-dot-low{background:${LOW}}`;
  (document.head ?? document.documentElement).appendChild(s);
}

// ---------------------------------------------------------------------------
// Init — page agent only; selection + panel commands are always live.
// ---------------------------------------------------------------------------

injectStyles();

// Restore the single-word preference so highlights match the panel's toggle
// even before the panel first syncs.
storageGet([HIDE_SINGLE_KEY, MODE_KEY, STATUS_VISIBILITY_KEY, JURISDICTIONS_KEY], (r) => {
  if (r && Array.isArray(r[JURISDICTIONS_KEY])) selectedJurisdictions = normalizeJurisdictions(r[JURISDICTIONS_KEY]);
  if (r && typeof r[HIDE_SINGLE_KEY] === 'boolean') hideSingleWord = r[HIDE_SINGLE_KEY] as boolean;
  if (r && r[STATUS_VISIBILITY_KEY]) visibleStatuses = normalizeStatusVisibility(r[STATUS_VISIBILITY_KEY]);
  if (r && (r[MODE_KEY] === 'any' || r[MODE_KEY] === 'amazon' || r[MODE_KEY] === 'etsy')) scanMode = r[MODE_KEY] as ScanMode;
});
