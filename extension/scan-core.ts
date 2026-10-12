// Pure, side-effect-free scan/listing helpers shared by the content script
// (duo.ts) and side panel (sidepanel.ts). Kept free of chrome / DOM imports so
// the logic is unit-testable in a plain Node runner (tests/extension/
// scan-core.test.ts) without a browser or jsdom. It imports exactly one thing
// from the core — the per-request word limit — via a relative path (a plain
// number, so the module stays browser-free) to keep that limit single-sourced.

import { normalizeClass } from './categories';
import type { TrademarkMatch } from './shared';
import { MAX_WORDS_PER_CHECK_REQUEST } from '../listing-core-runtime/src/core/listing/constants';

/** Stay under the trademark API's per-request candidate-overflow limit. Single
 *  source of truth: the core's MAX_WORDS_PER_CHECK_REQUEST — the core keyword
 *  screen chunks to the SAME value, so the scanner and the listing check can't
 *  drift (they were 110 vs 80 before). */
export const MAX_WORDS_PER_CHUNK = MAX_WORDS_PER_CHECK_REQUEST;

/** Group phrases into newline-joined chunks that each stay under the per-request
 *  word limit (a single over-limit phrase still goes out alone). */
export function chunkByWords(phrases: string[], maxWords: number = MAX_WORDS_PER_CHUNK): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const p of phrases) {
    const n = p.split(/\s+/).length;
    if (words + n > maxWords && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      words = 0;
    }
    current.push(p);
    words += n;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

/** Split an over-long block into sentence/segment pieces of at most `max` chars,
 *  so a long paragraph or bullet is screened in parts instead of skipped. A
 *  piece that still can't be split under `max` is dropped and reported via
 *  `dropped` so the caller can mark the scan INCOMPLETE. */
export function splitLongPhrase(text: string, max = 200): { pieces: string[]; dropped: boolean } {
  if (text.length <= max) return { pieces: [text], dropped: false };
  const pieces: string[] = [];
  let dropped = false;
  for (const part of text.split(/(?<=[.!?;:|•·])\s+|\s[–—-]\s/)) {
    const p = part.trim();
    if (!p) continue;
    if (p.length <= max) {
      pieces.push(p);
      continue;
    }
    // No punctuation to split on: fall back to word windows under the limit.
    let cur = '';
    for (const w of p.split(/\s+/)) {
      if (w.length > max) {
        dropped = true;
        continue;
      }
      if (cur && cur.length + 1 + w.length > max) {
        pieces.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) pieces.push(cur);
  }
  return { pieces, dropped };
}

/** Accumulation identity (page agent): a mark in a class against a given page
 *  text — serial + class + matched text. Lets repeated scans add to the page. */
export function matchAccumKey(m: TrademarkMatch): string {
  return `${m.serial_number}|${normalizeClass(m.international_class)}|${m.matched_text.toLowerCase()}`;
}

/** Fold `incoming` into `existing`, deduped by matchAccumKey, preserving order
 *  (existing first, then first-seen new). Pure — returns a new array. */
export function mergeMatches(
  existing: readonly TrademarkMatch[],
  incoming: readonly TrademarkMatch[]
): TrademarkMatch[] {
  const seen = new Set(existing.map(matchAccumKey));
  const out = existing.slice();
  for (const m of incoming) {
    const k = matchAccumKey(m);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

/** Display dedupe (side panel): serial + class + wordmark — one mark can match
 *  many page spans, but should appear once in the results list. */
export function dedupeMatches(matches: readonly TrademarkMatch[]): TrademarkMatch[] {
  const by = new Map<string, TrademarkMatch>();
  for (const m of matches) {
    by.set(`${m.serial_number}|${normalizeClass(m.international_class)}|${m.wordmark.toLowerCase()}`, m);
  }
  return Array.from(by.values());
}

/** Which Merch editor field a generated listing field maps to, by id then name.
 *  Bullets MUST be classified before description: the default bullet field is
 *  literally named "Bullet Point Description", so a description-first check would
 *  swallow both bullets. Returns null when it maps to no Merch field. */
export type MerchFieldKind = 'title' | 'brand' | 'bullet' | 'description' | null;

export function classifyMerchField(fieldId: string, fieldName: string): MerchFieldKind {
  const id = fieldId.toLowerCase();
  const name = fieldName.toLowerCase();
  if (id === 'title' || name.includes('title')) return 'title';
  if (id === 'brand' || name.includes('brand')) return 'brand';
  if (id.includes('bullet') || name.includes('bullet') || name.includes('feature')) return 'bullet';
  if (name.includes('description')) return 'description';
  return null;
}

/** True only on the Merch by Amazon editor host (merch.amazon.*). Bounds the
 *  `merch-detect`/`fill-listing` commands so their loose field selectors
 *  ([name="title"], [aria-label*="title"]…) can't match — let alone write into —
 *  a random non-Merch page. TLD tail bounded like UPLOAD_CAPTURE_HOSTS so
 *  `merch.amazon.com.evil.com` can't pass. */
export function isMerchEditorHost(hostname: string): boolean {
  return /(^|\.)merch\.amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(hostname);
}

/** Drop every element that sits inside another element of the list, keeping
 *  document order. Marketplace scope selectors overlap (an Etsy card matches
 *  several of them, an Amazon tile nests [data-asin] children), and walking the
 *  same card 3-4 times per flagged phrase froze big result pages. */
export function outermostElements<T extends { parentElement: T | null }>(els: readonly T[]): T[] {
  const set = new Set(els);
  const out: T[] = [];
  for (const el of set) {
    let inside = false;
    for (let p = el.parentElement; p && !inside; p = p.parentElement) inside = set.has(p);
    if (!inside) out.push(el);
  }
  return out;
}

export interface TextPart {
  readonly text: string;
  readonly isMatch: boolean;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[a-z0-9]/i.test(c);
}

/** Split `data` into match / non-match parts for every occurrence of the needle
 *  (case-insensitive, `needleLower` must already be lowercased). Unlike a bare
 *  substring split, a hit only counts at WORD BOUNDARIES — the trademark API
 *  matches whole words, so a mark like CAT must not paint inside "category" or
 *  "locate". Returns null when there's no whole-word occurrence. */
export function splitMatchParts(data: string, needleLower: string): TextPart[] | null {
  const lower = data.toLowerCase();
  const parts: TextPart[] = [];
  let pos = 0;
  let idx = lower.indexOf(needleLower, pos);
  while (idx !== -1) {
    const before = lower[idx - 1];
    const after = lower[idx + needleLower.length];
    if (isWordChar(before) || isWordChar(after)) {
      // Substring hit inside a larger word — keep scanning past it.
      pos = idx + 1;
      idx = lower.indexOf(needleLower, pos);
      continue;
    }
    if (idx > pos) parts.push({ text: data.slice(pos, idx), isMatch: false });
    parts.push({ text: data.slice(idx, idx + needleLower.length), isMatch: true });
    pos = idx + needleLower.length;
    idx = lower.indexOf(needleLower, pos);
  }
  if (parts.length === 0) return null;
  if (pos < data.length) parts.push({ text: data.slice(pos), isMatch: false });
  return parts;
}

/** Is it safe to auto-fill a generated listing into the live Merch editor?
 *  Never on a screening error or a flagged report — and a STALE report is
 *  explicitly not definitive (the panel already tells the user to re-check), so
 *  it can't drive hands-off fill either. When the user disabled trademark
 *  screening entirely, filling is their call. */
export function isTrademarkSafeForAutofill(
  trademark: { readonly clean: boolean; readonly stale?: boolean } | null,
  trademarkError: string | null,
  trademarkEnabled: boolean
): boolean {
  if (trademarkError) return false;
  if (!trademarkEnabled) return true;
  return trademark != null && trademark.clean === true && trademark.stale !== true;
}
