import { GeneratedListing, GeneratedField, ValidatedKeyword, ListingConfig } from '../types';
import { chatCompletion, extractAiJson, type AIConfig } from '@/lib/ai-provider';
import { MAX_TRADEMARK_WORDS, MAX_WORDS_PER_CHECK_REQUEST } from './constants';
import { isFamousSingleWordBrand } from './famousSingleWordPolicy';
import { clampToMaxChars } from './generateListing';
import { banTermFor, stripBannedWords } from './bannedWords';
import { normalizeText } from '../../../../lib/trademark/normalize';

// ============================================================
// TYPES
// ============================================================

export interface TrademarkMatch {
  jurisdiction?: 'US' | 'EUIPO';
  wordmark: string;
  matched_text: string;
  serial_number: string;
  registration_status: 'registered' | 'pending' | 'abandoned' | 'cancelled';
  international_class: string;
  owner: string | null;
  confidence: 'high' | 'low';
}

export interface TrademarkCheckResult {
  matches: TrademarkMatch[];
  total_matches: number;
  query_time_ms: number;
  /** API flagged its data as stale/under-construction — results may be incomplete
   *  (e.g. mid-backfill), so a 0-match response must NOT read as a clean "clear". */
  data_stale: boolean;
  truncated?: boolean;
  result_limit?: number;
  result_limit_max?: number;
}

export interface TrademarkChange {
  original: string;
  replacement: string;
  reason: string; // the trademarked term that triggered it
}

export interface FlaggedMark {
  term: string; // the text that matched in the listing (lowercase) — what a "Ban" adds
  wordmark: string;
  owner?: string;
  international_class: string;
  jurisdiction: string;
  registration_status?: string;
  serial_number: string;
}

export interface TrademarkReport {
  clean: boolean;
  /** A check hit stale/under-construction DB data — `clean` is NOT definitive. */
  stale: boolean;
  iterations: number;
  flaggedTerms: string[];
  /** One entry per mark taken out, with what to ban (`term`) and its details. */
  flaggedMarks: FlaggedMark[];
  changes: TrademarkChange[];
  originalListing: Record<string, string>; // fieldId -> content
  finalListing: Record<string, string>; // fieldId -> content
}

// ============================================================
// HELPERS
// ============================================================

function listingToRecord(listing: GeneratedListing): Record<string, string> {
  const record: Record<string, string> = {};
  for (const f of listing.fields) {
    record[f.fieldId] = f.content;
  }
  return record;
}

function isCommaFreeField(fieldId: string, fieldName: string): boolean {
  const id = fieldId.toLowerCase();
  const name = fieldName.toLowerCase();
  return id === 'title' || id === 'brand' || name.includes('title') || name.includes('brand');
}

// ============================================================
// CHECK LISTING AGAINST TRADEMARK API
// ============================================================

// Hard timeout for /check requests. Every other network path in the product has
// one (AI 60s, OpenClaw 120s, autosuggest 8s, extension page-scan 20s) — without
// this, a STALLED (not errored) trademark connection would hang the keyword
// screen and the listing check forever (in the extension that also pins kw.busy,
// disabling Generate until the panel is reopened). A timeout becomes a thrown
// error, which the fail-loud callers already surface correctly.
const CHECK_TIMEOUT_MS = 20000;
// Base URL of the trademark API deployment. Headless-safe: `process.env` exists
// in Node and is shimmed to `{}` by the extension build, so the guarded read
// never touches browser globals. Callers that can't set env (the extension
// sidepanel) override at runtime via setTrademarkApiBase.
const DEFAULT_API_BASE = 'http://localhost:3000';
let apiBase =
  (typeof process !== 'undefined' && process.env?.TRADEMARK_API_BASE) || DEFAULT_API_BASE;

/** Point trademark checks at a specific API deployment (no trailing slash needed). */
export function setTrademarkApiBase(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  apiBase = trimmed || DEFAULT_API_BASE;
}

// API key for a private deployment (REQUIRE_API_KEY=true). Node reads
// TRADEMARK_API_KEY; the extension has no env, so it sets the key at runtime.
let apiKeyOverride = '';

export function setTrademarkApiKey(key: string): void {
  apiKeyOverride = key.trim();
}

function trademarkApiKey(): string | undefined {
  return apiKeyOverride || (typeof process !== 'undefined' && process.env?.TRADEMARK_API_KEY) || undefined;
}
// On a 429, wait for the API's Retry-After (capped) and retry ONCE. The check
// paths fan out one request per listing field — and the rewrite loop repeats
// that — so a brief rate-limit window shouldn't kill an entire check run. A
// second 429 still throws (fail loud), so sustained throttling surfaces.
const RETRY_AFTER_CAP_MS = 30000;
export const TRADEMARK_JURISDICTIONS = ['US', 'EUIPO'] as const;
export type TrademarkJurisdiction = (typeof TRADEMARK_JURISDICTIONS)[number];

/** Clean a requested registry list: known codes only, canonical order, and
 *  US + EUIPO when nothing valid was given (the historical default). */
export function normalizeTrademarkJurisdictions(value: unknown): TrademarkJurisdiction[] {
  const wanted = new Set(
    (Array.isArray(value) ? value : [])
      .map((v) => String(v).trim().toUpperCase())
      .map((v) => (v === 'EU' ? 'EUIPO' : v))
  );
  const picked = TRADEMARK_JURISDICTIONS.filter((j) => wanted.has(j));
  return picked.length ? [...picked] : [...TRADEMARK_JURISDICTIONS];
}

async function fetchCheck(
  text: string,
  classes: string[],
  reqHeaders: Record<string, string>,
  jurisdictions: readonly TrademarkJurisdiction[],
  maxResults?: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(`${apiBase}/api/v1/check`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        text,
        classes,
        include_dead: false,
        jurisdictions,
        ...(maxResults !== undefined ? { max_results: maxResults } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(`Trademark check timed out after ${Math.round(CHECK_TIMEOUT_MS / 1000)}s — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds to wait from a 429's Retry-After header (or null if absent/garbage). */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, RETRY_AFTER_CAP_MS) : null;
}

async function checkText(
  text: string,
  classes: string[],
  reqHeaders: Record<string, string>,
  jurisdictions: readonly TrademarkJurisdiction[] = TRADEMARK_JURISDICTIONS,
  beforeRequest?: () => void,
  maxResults?: number
): Promise<TrademarkCheckResult> {
  beforeRequest?.();
  let response = await fetchCheck(text, classes, reqHeaders, jurisdictions, maxResults);

  if (response.status === 429) {
    const wait = retryAfterMs(response) ?? 5000;
    await new Promise((r) => setTimeout(r, wait));
    beforeRequest?.();
    response = await fetchCheck(text, classes, reqHeaders, jurisdictions, maxResults);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Trademark API error: ${err}`);
  }

  const data = (await response.json()) as {
    matches?: unknown;
    total_matches?: number;
    query_time_ms?: number;
    data_stale?: boolean;
    truncated?: boolean;
    result_limit?: number;
    result_limit_max?: number;
    jurisdictions_checked?: unknown;
  };
  // Fail loud on a malformed 200 (a proxied error page, an `{error:...}` body,
  // or a schema change) so a broken response can never read as "no conflicts".
  if (!data || !Array.isArray(data.matches)) {
    throw new Error('Trademark API: unexpected response shape');
  }
  const checked = Array.isArray(data.jurisdictions_checked)
    ? data.jurisdictions_checked.filter((value): value is string => typeof value === 'string')
    : [];
  const missing = jurisdictions.filter((jurisdiction) => !checked.includes(jurisdiction));
  if (missing.length > 0) {
    throw new Error(
      `Trademark API did not check required jurisdictions: ${missing.join(', ')}. ` +
      `Checked: ${checked.join(', ') || 'none'}. Results are unverified.`
    );
  }
  return {
    matches: data.matches as TrademarkMatch[],
    total_matches: data.total_matches || 0,
    query_time_ms: data.query_time_ms || 0,
    data_stale: data.data_stale === true,
    truncated: data.truncated === true || (typeof data.total_matches === 'number' && data.total_matches > data.matches.length),
    result_limit: data.result_limit,
    result_limit_max: data.result_limit_max,
  };
}

/** Older servers advertise no limit contract: keep partition/unverified guards. */
async function checkWithExpandedLimit(text: string, classes: string[], headers: Record<string, string>, jurisdictions: readonly TrademarkJurisdiction[], consumeRequest: () => void, retain: (result: TrademarkCheckResult) => void): Promise<TrademarkCheckResult> {
  let result = await checkText(text, classes, headers, jurisdictions, consumeRequest);
  retain(result);
  for (const limit of [100, 500]) {
    if (!result.truncated) break;
    const applied = result.result_limit;
    const maximum = result.result_limit_max;
    if (!Number.isInteger(applied) || !Number.isInteger(maximum) || applied! < 1 || maximum! > 500 || maximum! < applied! || limit <= applied! || limit > maximum!) break;
    result = await checkText(text, classes, headers, jurisdictions, consumeRequest, limit);
    retain(result);
    // An ignored field never proves that an expanded query actually ran.
    if (result.result_limit !== limit) break;
  }
  return result;
}

// The longest mark the API matches is MAX_TRADEMARK_WORDS words. Consecutive
// field chunks overlap by that minus
// one so a multi-word mark straddling a chunk boundary still appears whole in at
// least one chunk — a non-overlapping split could hide it and read as a false
// "clear", the worst screener failure.
const MAX_MARK_WORDS = MAX_TRADEMARK_WORDS;

/**
 * Split a field's text into ≤`maxWords`-word chunks (overlapping by
 * MAX_MARK_WORDS-1). Exported for testing. A single /check request expands its
 * text into exact n-gram candidates through MAX_MARK_WORDS and rejects an
 * over-limit candidate set; a long field (an Etsy description runs 300+ words)
 * would otherwise make the whole trademark check error out. Returns [] for
 * empty text and [text] when it already fits, so short fields are unchanged.
 */
export function chunkFieldText(content: string, maxWords: number): string[] {
  const normalized = normalizeText(content);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= maxWords) return [normalized];
  const step = Math.max(1, maxWords - (MAX_MARK_WORDS - 1));
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
    if (i + maxWords >= words.length) break;
  }
  return chunks;
}

export async function checkForTrademarks(
  listing: GeneratedListing,
  classes: string[] = ['025'],
  jurisdictions?: readonly string[]
): Promise<TrademarkCheckResult> {
  if (!classes || classes.length === 0) classes = ['025'];
  const juris = normalizeTrademarkJurisdictions(jurisdictions);

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = trademarkApiKey();
  if (apiKey) {
    reqHeaders['X-API-Key'] = apiKey;
  }

  // Chunk each field so a long field can't overflow the API's candidate cap and
  // fail the whole check. Matches are merged + de-duplicated below, so the
  // overlap between chunks is harmless.
  const chunks = listing.fields.flatMap((f) => chunkFieldText(f.content, MAX_WORDS_PER_CHECK_REQUEST));
  const results: TrademarkCheckResult[] = [];
  let requests = 0;
  let incomplete = false;
  const consumeRequest = () => { if (requests >= 256) throw new Error('Trademark coverage request budget exhausted'); requests++; };
  async function checkChunk(chunk: string, classScope = classes, registryScope = juris): Promise<void> {
    try {
      const result = await checkWithExpandedLimit(chunk, classScope, reqHeaders, registryScope, consumeRequest, result => results.push(result));
      if (!result.truncated) return;
      // Partition the full requested scope before shortening text. Each child
      // retains every phrase; every class/registry partition must complete.
      if (classScope.length > 1) {
        const midpoint = Math.ceil(classScope.length / 2);
        await checkChunk(chunk, classScope.slice(0, midpoint), registryScope);
        await checkChunk(chunk, classScope.slice(midpoint), registryScope);
        return;
      }
      if (registryScope.length > 1) {
        const midpoint = Math.ceil(registryScope.length / 2);
        await checkChunk(chunk, classScope, registryScope.slice(0, midpoint));
        await checkChunk(chunk, classScope, registryScope.slice(midpoint));
        return;
      }
      const count = chunk.split(' ').length;
      if (count <= MAX_MARK_WORDS) { incomplete = true; return; }
      const childSize = Math.max(MAX_MARK_WORDS, Math.ceil((count + MAX_MARK_WORDS - 1) / 2));
      const children = chunkFieldText(chunk, childSize);
      if (children.some(child => child.split(' ').length >= count)) { incomplete = true; return; }
      for (const child of children) await checkChunk(child, classScope, registryScope);
    } catch { incomplete = true; }
  }
  for (const chunk of chunks) await checkChunk(chunk);

  // Deduplicate matches by jurisdiction + serial_number + matched_text. US and
  // EUIPO identifiers can overlap, so omitting jurisdiction could hide one
  // registry's result when both return the same text.
  const seen = new Set<string>();
  const allMatches: TrademarkMatch[] = [];
  let totalQueryTime = 0;
  let stale = incomplete;

  for (const r of results) {
    totalQueryTime += r.query_time_ms;
    if (r.data_stale) stale = true;
    for (const m of r.matches) {
      const key = `${m.jurisdiction ?? 'US'}:${m.serial_number}:${m.matched_text}`;
      if (!seen.has(key)) {
        seen.add(key);
        allMatches.push(m);
      }
    }
  }

  return {
    matches: allMatches,
    total_matches: allMatches.length,
    query_time_ms: totalQueryTime,
    data_stale: stale,
  };
}

// ============================================================
// FILTER TO ONLY ACTIONABLE MATCHES
// ============================================================

/**
 * Check if the matched text is a pluralized/common-word form of the trademark.
 * e.g. "champions" matched against trademark "CHAMPION" → allowed,
 * because "champions" is a normal English word.
 */
function isPluralizedForm(matchedText: string, wordmark: string): boolean {
  const matched = matchedText.toLowerCase().trim();
  const mark = wordmark.toLowerCase().trim();
  if (matched === mark) return false; // exact match, not pluralized
  if (!matched.startsWith(mark) || matched.length <= mark.length) return false;
  // Only a real SUFFIX on the same token counts as a plural/inflection (e.g.
  // "champions" for CHAMPION). If what follows the mark is whitespace, this is the
  // mark PLUS adjacent words (e.g. "nike air" for NIKE) — that is NOT a
  // pluralization, and treating it as one would silently clear a real registered
  // mark (a false "clear", the worst failure mode). Keep it actionable.
  return !/\s/.test(matched.slice(mark.length));
}

/**
 * Verify the matched text contains ALL words from the wordmark.
 * e.g. wordmark "DECLARATION OF INDEPENDENCE" only matches if ALL three words
 * appear in the matched text. If only "declaration" was found, it's NOT a match.
 */
function isExactWordmarkMatch(matchedText: string, wordmark: string): boolean {
  // Normalize BOTH sides the same way before the whole-word check. The raw DB
  // wordmark keeps its punctuation (LEVI'S, COCA-COLA, VICTORIA'S SECRET) while
  // the API's matched_text is already punctuation-folded — comparing them raw
  // made every punctuated mark impossible to match, silently clearing a real
  // registered mark (a false "clear", the worst failure mode for a screener).
  const normalizedMatched = normalizeForMatch(matchedText);
  const words = normalizeForMatch(wordmark).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  // Whole-word, not substring: "ART CO" must not match "smart cocoa".
  return words.every((word) => termContainsMark(normalizedMatched, word));
}

/** Whole-word containment so a short mark ("ART") doesn't flag substrings
 *  ("party", "heart", "smart"). Any non-alphanumeric char counts as a boundary. */
function termContainsMark(term: string, mark: string): boolean {
  if (term === mark) return true;
  const esc = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i').test(term);
}

/** A wordmark made of a single word (e.g. "NIKE"), vs a phrase ("JUST DO IT"). */
function isSingleWordMark(wordmark: string): boolean {
  return normalizeText(wordmark).split(' ').filter(Boolean).length === 1;
}

/** Conservative denylist exception to the ordinary-single-word policy. */
export function isFamousSingleWordMark(wordmark: string): boolean {
  return isFamousSingleWordBrand(wordmark);
}

/** Lowercase and fold punctuation the same way the API's text normalizer does
 *  for ASCII: strip apostrophes (LEVI'S -> levis) and turn hyphens/other
 *  punctuation into spaces (COCA-COLA -> coca cola). This keeps a raw DB
 *  wordmark comparable to the API's already-folded matched_text. Unicode/accent
 *  folding is the API's job and is already applied to matched_text. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True if `word` is `mark`, or a simple English plural/inflection of it
 *  (mark+s, mark+es, or the -ies form). Mirrors the singular-form widening the
 *  API applies to query candidates (lib/trademark/ngrams.ts `addSingularForms`),
 *  so a plural keyword ("nikes") maps back to the singular mark ("nike") the API
 *  returned in matched_text. Kept tight — only these suffixes — so a shared
 *  prefix ("caterpillar" vs "cat") is NOT treated as a match. */
function isInflectedForm(word: string, mark: string): boolean {
  if (word === mark) return true;
  if (mark.endsWith('y') && word === `${mark.slice(0, -1)}ies`) return true;
  if (word.startsWith(mark)) {
    const suffix = word.slice(mark.length);
    return suffix === 's' || suffix === 'es';
  }
  return false;
}

/** Does a keyword `term` contain a hit's `matchedText` — as a whole word, a
 *  multi-word phrase, or a plural/inflected single-word form? Used to attribute
 *  a confirmed trademark hit back to the term that produced it. */
function termMatchesHit(term: string, matchedText: string): boolean {
  const mt = normalizeForMatch(matchedText);
  if (!mt) return false;
  const t = normalizeForMatch(term);
  if (termContainsMark(t, mt)) return true; // exact whole-word / multi-word phrase
  if (/\s/.test(mt)) return false; // multi-word marks don't inflect
  return t.split(' ').some((w) => isInflectedForm(w, mt)); // plural single-word mark
}

/**
 * Attribute confirmed trademark hits back to the keyword terms that produced
 * them. Exported for testing. Maps a term even when the API returned a
 * de-pluralized matched_text ("nike" for the query "nikes") or a
 * punctuation-folded one ("levis" for "Levi's") — cases where a naive
 * whole-word check dropped the hit and silently cleared a registered mark.
 * A confirmed hit that maps to no term via the precise rules falls back to
 * loose containment rather than being dropped: over-flagging is safe, a false
 * "clear" is not.
 */
export function attributeHitsToTerms(
  chunk: string[],
  hits: TrademarkMatch[]
): Map<string, TrademarkMatch> {
  const flagged = new Map<string, TrademarkMatch>();
  for (const m of hits) {
    let mapped = false;
    for (const term of chunk) {
      const lower = term.toLowerCase();
      if (termMatchesHit(term, m.matched_text)) {
        mapped = true;
        if (!flagged.has(lower)) flagged.set(lower, m);
      }
    }
    if (mapped) continue;
    // Backstop: never silently drop a confirmed registered-mark hit. If the
    // precise rules attributed it to no term (unexpected normalization), fall
    // back to substring containment so the conflict still surfaces somewhere.
    const mt = normalizeForMatch(m.matched_text);
    if (!mt) continue;
    for (const term of chunk) {
      const lower = term.toLowerCase();
      if (normalizeForMatch(term).includes(mt) && !flagged.has(lower)) {
        flagged.set(lower, m);
      }
    }
  }
  return flagged;
}

export function getActionableMatches(
  matches: TrademarkMatch[],
  allowSingleWord = false
): TrademarkMatch[] {
  return matches.filter((m) => {
    if (m.registration_status !== 'registered' && m.registration_status !== 'pending') return false;

    // Deliberately NOT gated on `confidence`. `confidence` is a length-based
    // DISPLAY hint that scores every single word < 5 chars as 'low' — gating on
    // it here silently dropped famous short marks (NIKE, VANS, PUMA, GAP, KIA)
    // from the listing check even though the keyword screen
    // (screenTermsForTrademarks) correctly flags them. A registered/pending
    // EXACT whole-word match is actionable regardless of length; users who want
    // to keep single-word marks opt out via `allowSingleWord` below.

    // Ordinary single-word registrations are informational when the POD policy
    // is enabled. Famous/well-known brands remain actionable.
    if (
      allowSingleWord &&
      isSingleWordMark(m.wordmark) &&
      !isFamousSingleWordMark(m.wordmark)
    ) return false;

    // The matched text must contain ALL words from the wordmark.
    // "Declaration of Independence" only matches if all 3 words are present,
    // not just "declaration" alone.
    if (!isExactWordmarkMatch(m.matched_text, m.wordmark)) return false;

    // If the matched text is a pluralized/suffixed form of the trademark, allow it
    // e.g. "champions" for trademark "CHAMPION" — it's a normal English word
    if (isPluralizedForm(m.matched_text, m.wordmark)) return false;

    // For POD safety, any registered/pending high-confidence exact match is
    // actionable. Common-word decisions should be reviewed explicitly instead
    // of being silently reported as clear.
    return true;
  });
}

// ============================================================
// SCREEN INDIVIDUAL TERMS (e.g. candidate keywords) FOR TRADEMARKS
// ============================================================

/**
 * Screen individual terms (keyword candidates) against the trademark DB and
 * return the ones that exactly match a registered/pending wordmark — mapped back
 * to the term that flagged it (lowercased term -> the matching TrademarkMatch,
 * so callers can show owner/status/class/serial). Unlike the listing
 * check, this does NOT require "high" confidence: a bare keyword that IS a
 * registered mark (e.g. NIKE) is scored "low" by the API without sentence
 * context, yet is exactly what we want to warn on. Requests fail loud so a
 * rate-limit surfaces as an error rather than a false "no conflicts".
 */
export async function screenTermsForTrademarks(
  terms: string[],
  classes: string[] = ['025'],
  allowSingleWord = false,
  jurisdictions?: readonly string[]
): Promise<{ flagged: Map<string, TrademarkMatch>; stale: boolean }> {
  const juris = normalizeTrademarkJurisdictions(jurisdictions);
  const flagged = new Map<string, TrademarkMatch>();
  const unique = Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean)));
  if (!unique.length) return { flagged, stale: false };
  if (!classes || classes.length === 0) classes = ['025'];

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = trademarkApiKey();
  if (apiKey) reqHeaders['X-API-Key'] = apiKey;

  // Group terms into newline-joined blobs (MAX_WORDS_PER_CHECK_REQUEST words each)
  // so matched_text still maps back to a term while keeping the request count low.
  const chunks: string[][] = [];
  let cur: string[] = [];
  let words = 0;
  for (const term of unique) {
    const n = term.split(/\s+/).length;
    if (words + n > MAX_WORDS_PER_CHECK_REQUEST && cur.length) {
      chunks.push(cur);
      cur = [];
      words = 0;
    }
    cur.push(term);
    words += n;
  }
  if (cur.length) chunks.push(cur);

  // Fail loud: if a request errors (e.g. rate-limited), let it throw so the
  // caller shows an error rather than a false "no conflicts" all-clear.
  let stale = false;
  const results: { chunk: string[]; matches: TrademarkMatch[]; dataStale: boolean }[] = [];
  // A binary split is at most 2*N-1 requests. Keep a hard per-screen budget and
  // preserve confirmed hits if coverage, transport or even a single term fails.
  let requests = 0;
  const budget = 256;
  const consumeRequest = () => { if (requests >= budget) throw new Error('Trademark coverage request budget exhausted'); requests++; };
  async function screenChunk(chunk: string[]): Promise<void> {
    try {
      const res = await checkWithExpandedLimit(chunk.join('\n'), classes, reqHeaders, juris, consumeRequest, result => results.push({ chunk, matches: result.matches, dataStale: result.data_stale }));
      if (res.truncated) {
        if (chunk.length === 1) { stale = true; return; }
        const midpoint = Math.ceil(chunk.length / 2);
        await screenChunk(chunk.slice(0, midpoint));
        await screenChunk(chunk.slice(midpoint));
      }
    } catch { stale = true; }
  }
  // Sequential retries avoid amplifying traffic while resolving truncated sets.
  for (const chunk of chunks) await screenChunk(chunk);
  for (const r of results) if (r.dataStale) stale = true;

  for (const { chunk, matches } of results) {
    // Keyword-appropriate filter: flag a registered/pending wordmark exactly
    // matched within a term, regardless of the API's confidence score — famous
    // single-word marks (NIKE) score "low" as bare keywords but must still warn.
    const hits = matches.filter(
      (m) =>
        (m.registration_status === 'registered' || m.registration_status === 'pending') &&
        isExactWordmarkMatch(m.matched_text, m.wordmark) &&
        !isPluralizedForm(m.matched_text, m.wordmark) &&
        !(
          allowSingleWord &&
          isSingleWordMark(m.wordmark) &&
          !isFamousSingleWordMark(m.wordmark)
        )
    );
    // Map each hit back to the term(s) that produced it. Handles the API's
    // de-pluralized / punctuation-folded matched_text so a plural or possessive
    // keyword ("nikes", "Levi's") isn't silently dropped.
    for (const [term, m] of attributeHitsToTerms(chunk, hits)) {
      if (!flagged.has(term)) flagged.set(term, m);
    }
  }
  return { flagged, stale };
}

// ============================================================
// REWRITE LISTING VIA AI TO REMOVE TRADEMARKED TERMS
// ============================================================

async function rewriteListingWithoutTrademarks(
  listing: GeneratedListing,
  flaggedTerms: string[],
  validatedKeywords: ValidatedKeyword[],
  config: ListingConfig,
  aiConfig: AIConfig
): Promise<{ fields: Record<string, string>; changes: TrademarkChange[] }> {
  const selectedKeywords = validatedKeywords
    .filter((kw) => kw.selected)
    .map((k) => (k.isPhrase ? `"${k.word}"` : k.word))
    .join(', ');

  const fieldContents = listing.fields
    .map((f) => `${f.fieldName} (id: "${f.fieldId}"): ${f.content}`)
    .join('\n');

  const fieldLimits = config.fields
    .map((f) => `${f.name} (${f.id}) max ${f.maxChars} chars`)
    .join(', ');

  const jsonExample: Record<string, string> = {};
  for (const f of listing.fields) {
    jsonExample[f.fieldId] = `New ${f.fieldName.toLowerCase()} here`;
  }

  const prompt = `You are rewriting an Amazon Merch listing to remove trademarked terms.

CURRENT LISTING:
${fieldContents}

TRADEMARKED TERMS TO REMOVE (these are registered trademarks — do NOT use them):
${flaggedTerms.join(', ')}

AVAILABLE KEYWORDS (use these as replacements where possible):
${selectedKeywords}

RULES:
- Remove or replace every trademarked term listed above
- Keep the same character limits: ${fieldLimits}
- Maintain keyword density — use the available keywords
- Keep it natural and readable
- Do NOT use: ${config.forbiddenWords.join(', ')}
- LONGTAIL PRIORITY: Keep multi-word phrases together

For each change you make, note what you changed and why.

Respond in this exact JSON format:
${JSON.stringify({ ...jsonExample, changes: [{ original: 'original phrase', replacement: 'new phrase', reason: 'TRADEMARK_NAME is trademarked' }] }, null, 2)}`;

  const rawResponse = await chatCompletion(aiConfig, prompt, { maxTokens: 1500 });

  const jsonText = extractAiJson(rawResponse);
  if (!jsonText) {
    throw new Error('Failed to parse rewrite response as JSON');
  }

  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Trademark rewrite JSON was not an object');
  }

  const fields: Record<string, string> = {};
  for (const f of listing.fields) {
    // Guard against a non-string field value in the AI's JSON (an array/object
    // would crash the sanitize/clamp path); fall back to the original content.
    fields[f.fieldId] = typeof parsed[f.fieldId] === 'string' ? parsed[f.fieldId] : f.content;
  }

  return {
    fields,
    changes: (parsed.changes || []).map(
      (c: { original: string; replacement: string; reason: string }) => ({
        original: c.original,
        replacement: c.replacement,
        reason: c.reason,
      })
    ),
  };
}

// ============================================================
// REBUILD GeneratedListing FROM FIELD RECORD
// ============================================================

/** Exported for testing. */
export function rebuildListing(
  fieldContents: Record<string, string>,
  config: ListingConfig,
  validatedKeywords: ValidatedKeyword[],
  originalMetadata: GeneratedListing['metadata']
): GeneratedListing {
  const countKw = (content: string) => {
    const lower = content.toLowerCase();
    const used: string[] = [];
    let cert = 0;
    let fill = 0;
    for (const kw of validatedKeywords) {
      // Word-boundary, not substring: "art" must not count as used inside
      // "start", or the rebuilt listing's keyword stats over-report coverage.
      if (termContainsMark(lower, kw.word.toLowerCase())) {
        used.push(kw.word);
        if (kw.certified) cert++;
        else fill++;
      }
    }
    return { used, cert, fill };
  };

  const fields: GeneratedField[] = config.fields.map((f) => {
    // The rewrite is only *asked* to avoid banned words; enforce it here exactly
    // like the first draft is (a trademark could otherwise be swapped for "gift").
    const rawContent = stripBannedWords(fieldContents[f.id] || '', config.forbiddenWords);
    const commaProcessed = isCommaFreeField(f.id, f.name)
      ? rawContent.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
      : rawContent;
    // Clamp to the field's character limit. The AI rewrite is only *asked* to
    // stay within limits; without this a longer replacement (a multi-word phrase
    // swapped in for a trademark) shipped over-limit content straight to
    // copy / marketplace-fill / export, where the panel even styled it green.
    const content = clampToMaxChars(commaProcessed, f.maxChars);
    const { used, cert, fill } = countKw(content);
    return {
      fieldId: f.id,
      fieldName: f.name,
      content,
      charCount: content.length,
      maxChars: f.maxChars,
      keywordsUsed: used,
      certifiedCount: cert,
      fillerCount: fill,
    };
  });

  const allUsed = new Set(fields.flatMap((f) => f.keywordsUsed));
  let totalCertified = 0;
  let totalFiller = 0;
  for (const word of allUsed) {
    const kw = validatedKeywords.find((k) => k.word === word);
    if (kw?.certified) totalCertified++;
    else totalFiller++;
  }

  return {
    fields,
    metadata: {
      ...originalMetadata,
      generatedAt: new Date().toISOString(),
      totalCertifiedUsed: totalCertified,
      totalFillerUsed: totalFiller,
    },
  };
}

// ============================================================
// MAIN: CHECK + REWRITE LOOP
// ============================================================

const MAX_ITERATIONS = 3;

export async function trademarkCheckAndRewrite(
  listing: GeneratedListing,
  validatedKeywords: ValidatedKeyword[],
  config: ListingConfig,
  aiConfig: AIConfig,
  onProgress?: (message: string) => void
): Promise<TrademarkReport> {
  const originalListing = listingToRecord(listing);

  let currentListing = listing;
  let allChanges: TrademarkChange[] = [];
  let allFlaggedTerms: string[] = [];
  const flaggedMarks = new Map<string, FlaggedMark>();
  let stale = false;
  let iteration = 0;

  for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    onProgress?.(`Checking for trademarks (pass ${iteration + 1})...`);

    // Check current listing against trademark DB
    const result = await checkForTrademarks(currentListing, config.trademarkClasses, config.trademarkJurisdictions);
    if (result.data_stale) stale = true;
    const actionable = getActionableMatches(result.matches, config.allowSingleWordTrademarks);

    if (actionable.length === 0) {
      // No actionable marks — but only a DEFINITIVE clear if the DB wasn't stale.
      return {
        clean: !stale,
        stale,
        iterations: iteration + 1,
        flaggedTerms: allFlaggedTerms,
        flaggedMarks: [...flaggedMarks.values()],
        changes: allChanges,
        originalListing,
        finalListing: listingToRecord(currentListing),
      };
    }

    // Extract unique trademarked terms
    const newFlagged = [...new Set(actionable.map((m) => m.wordmark))];
    for (const m of actionable) {
      const term = banTermFor(m);
      const key = `${term}|${m.wordmark}|${m.jurisdiction ?? 'US'}`;
      if (!flaggedMarks.has(key)) {
        flaggedMarks.set(key, {
          term,
          wordmark: m.wordmark,
          owner: m.owner ?? undefined,
          international_class: m.international_class,
          jurisdiction: m.jurisdiction ?? 'US',
          registration_status: m.registration_status,
          serial_number: m.serial_number,
        });
      }
    }
    allFlaggedTerms = [...new Set([...allFlaggedTerms, ...newFlagged])];

    onProgress?.(
      `Found ${actionable.length} trademark match${actionable.length > 1 ? 'es' : ''}: ${newFlagged.join(', ')}. Rewriting...`
    );

    // Rewrite to remove trademarked terms
    const rewritten = await rewriteListingWithoutTrademarks(
      currentListing,
      allFlaggedTerms,
      validatedKeywords,
      config,
      aiConfig
    );

    allChanges = [...allChanges, ...rewritten.changes];

    // Rebuild the listing object
    currentListing = rebuildListing(rewritten.fields, config, validatedKeywords, listing.metadata);
  }

  // Exhausted iterations — re-verify the FINAL rewrite (its pass was never
  // re-checked) so `clean` reflects a real check of the listing we return.
  const finalResult = await checkForTrademarks(currentListing, config.trademarkClasses, config.trademarkJurisdictions);
  if (finalResult.data_stale) stale = true;
  const finalActionable = getActionableMatches(finalResult.matches, config.allowSingleWordTrademarks);
  return {
    clean: finalActionable.length === 0 && !stale,
    stale,
    iterations: iteration,
    flaggedTerms: allFlaggedTerms,
    flaggedMarks: [...flaggedMarks.values()],
    changes: allChanges,
    originalListing,
    finalListing: listingToRecord(currentListing),
  };
}
