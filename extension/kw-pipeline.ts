// Keyword pipeline + results rendering for the Keywords tab. Runs the
// vision → candidates → Amazon-validate → rank → listing → trademark flow against
// the shared core, and renders the results UI. Depends on kw-state + core only
// (no settings imports → no cycle).

import { trademarkCheckAndRewrite, screenTermsForTrademarks, setTrademarkApiKey } from '@/core/listing/trademarkCheck';
import type { TrademarkMatch } from '@/core/listing/trademarkCheck';
import type { AutosuggestFetcher, ValidatedKeyword } from '@/core/types';
import { amazonAutosuggest } from '@/core/validation/amazonAutosuggest';
import type { AIConfig } from '@/lib/ai-provider';
import {
  generateKeywords,
  produceListing,
  runListingPipeline,
  appendKeywordsToListing,
  type PipelinePhase,
  type PipelineProgress,
} from '@/core/pipeline/runListingPipeline';
import { buildExportResult } from '@/core/pipeline/exportResult';
import { activeTabId, escapeHtml as esc, escAttr, loadJurisdictions, loadTrademarkApiKey, storageLocalGet, trademarkRecordUrl, storageLocalSet } from './shared';

/** Hand the trademark API key (private deployment) to the bundled core. */
async function applyTrademarkApiKey(): Promise<void> {
  const key = await loadTrademarkApiKey();
  if (key) setTrademarkApiKey(key);
}
import { classifyMerchField, isTrademarkSafeForAutofill } from './scan-core';
import { kw, el, kwAiConfig, kwHasCreds, kwSaveSettings, kwUpdateGenerateEnabled } from './kw-state';
import { banTrademark } from '@/core/listing/bannedWords';
import type { BannedTrademark } from '@/core/types';
import { renderConfigEditor } from './kw-settings';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lowercased keyword -> the matching TrademarkMatch (wordmark, owner, status,
// class, serial). Populated by screenKeywords() after each analyze/generate;
// drives the red "trademarked" pill styling + the hover info popup in chipHtml.
let trademarkedWords = new Map<string, TrademarkMatch>();

// Tracks the keyword trademark-screen so the UI can prove it ran: 'idle' (not yet),
// 'running' (DB query in flight), 'done' (finished — see trademarkedWords for hits),
// 'error' (the screen failed).
let tmScreenState: 'idle' | 'running' | 'done' | 'error' = 'idle';
// The trademark DB flagged its data stale (e.g. mid-backfill) — a "no conflicts"
// result is then UNVERIFIED, not a definitive clear.
let tmScreenStale = false;

// Monotonic run token. Bumped at the start of every run + on Clear, so a slow
// trademark screen that resolves after a newer run/clear discards its result
// instead of painting stale red flags onto the wrong keyword set.
let kwRunId = 0;

// The last design an Auto-mode hands-off run was triggered for. connectSite is
// called on every panel refocus; without this, a FAILED run (validated/listing
// stay empty) would re-fire the whole paid AI pipeline on every refocus.
let autoRanForImage: string | null = null;

// Set when AI ranking was skipped (API error / unparseable response) and the
// keywords are shown in their ORIGINAL order — the list would otherwise look
// ranked when it isn't. Cleared at the start of each run.
let rankingSkipped = false;

/** Screen the current candidate keywords against the trademark DB (selected registries,
 *  configured classes) and repaint so trademarked pills turn red. Best-effort —
 *  a failure surfaces as a retry-able note (via tmScreenHtml) rather than silently. */
async function screenKeywords(): Promise<void> {
  const terms = kw.validated.map((k) => k.word);
  const myRun = kwRunId;
  if (!terms.length) {
    trademarkedWords = new Map();
    tmScreenState = 'idle';
    return;
  }
  tmScreenState = 'running';
  renderResults();
  let flagged = new Map<string, TrademarkMatch>();
  let stale = false;
  let ok = true;
  try {
    const res = await screenTermsForTrademarks(
      terms,
      kw.config.trademarkClasses,
      kw.config.allowSingleWordTrademarks,
      await loadJurisdictions()
    );
    flagged = res.flagged;
    stale = res.stale;
  } catch {
    ok = false;
  }
  // A newer run or a Clear happened while we awaited — discard this stale screen
  // so its flags can't paint onto a different keyword set.
  if (kwRunId !== myRun) return;
  trademarkedWords = ok ? flagged : new Map();
  tmScreenStale = ok ? stale : false;
  tmScreenState = ok ? 'done' : 'error';
  renderResults();
}

/** One-line banner showing the keyword trademark-screen state + result, so the
 *  user knows the check ran (and isn't left guessing when nothing is flagged). */
function tmScreenHtml(): string {
  if (!kw.validated.length) return '';
  if (tmScreenState === 'running') {
    return `<div class="kw-tmscreen kw-tmscreen-run"><span class="spin"></span><span class="kw-tmscreen-quip">Screening keywords for trademarks…</span></div>`;
  }
  if (tmScreenState === 'error') {
    return `<div class="kw-tmscreen kw-tmscreen-warn">⚠ Couldn't screen keywords for trademarks — try Analyze again.</div>`;
  }
  if (tmScreenState === 'done') {
    const n = trademarkedWords.size;
    const cls = kw.config.trademarkClasses.join(', ');
    if (tmScreenStale) {
      return `<div class="kw-tmscreen kw-tmscreen-warn">⚠ Trademark DB data is updating — this screen is UNVERIFIED${n ? ` (${n} flagged so far)` : ''}. Re-check before publishing.</div>`;
    }
    return n
      ? `<div class="kw-tmscreen kw-tmscreen-warn">⚠ ${n} keyword${n === 1 ? '' : 's'} may be trademarked — shown in red below.</div>`
      : `<div class="kw-tmscreen kw-tmscreen-ok">✓ Trademark-screened (US + EU, class ${esc(cls)}) — no conflicts found.</div>`;
  }
  return '';
}

/** Banner shown when AI ranking was skipped — the keyword order is the raw
 *  generation order, not best-first, and the user should know that. */
function rankWarnHtml(): string {
  if (!rankingSkipped || !kw.validated.length) return '';
  return `<div class="kw-tmscreen kw-tmscreen-warn">⚠ Keyword ranking unavailable — showing keywords unranked (order is not best-first).</div>`;
}

/** Banner shown when Amazon-validation couldn't actually check some keywords
 *  (autosuggest rate-limited / unreachable). Without it those keywords look like
 *  rejected misses; this says they're simply unchecked, not disqualified. */
function validateWarnHtml(): string {
  const n = kw.validated.filter((k) => !k.certified && k.unverified === true).length;
  if (!n) return '';
  return `<div class="kw-tmscreen kw-tmscreen-warn">⚠ ${n} keyword${n === 1 ? '' : 's'} couldn't be checked on Amazon (autosuggest didn't respond) — shown dashed below, not certified either way. Re-run to retry.</div>`;
}

// Amazon autosuggest — the side panel is an extension page, so with `<all_urls>`
// host permission it hits completion.amazon.com directly. The fetcher lives in
// the core so the CLI uses the exact same contract.
const autosuggestFetcher: AutosuggestFetcher = amazonAutosuggest;

// ---------------------------------------------------------------------------
// Image load + page grab
// ---------------------------------------------------------------------------

export function kwSetImage(dataUrl: string): void {
  // Only accept a real inline image. Both paths (file picker -> FileReader,
  // grab-from-page -> canvas.toDataURL) produce a `data:image/...` URL; reject
  // anything else so a poisoned grab can't push a foreign/`javascript:`-ish src
  // into the preview <img> or downstream to the AI call.
  if (!/^data:image\//i.test(dataUrl)) return;
  kw.imageBase64 = dataUrl;
  const preview = el('kw-preview') as HTMLImageElement;
  preview.src = dataUrl;
  preview.hidden = false;
  const empty = document.getElementById('kw-preview-empty');
  if (empty) empty.hidden = true; // swap the "Choose image" placeholder for the art
  kwUpdateGenerateEnabled();
}

export function kwGrabNote(text: string): void {
  const note = el('kw-grab-note');
  note.textContent = text;
  note.hidden = !text;
}

// The kw-body placeholder shown before any run — mirrors the initial markup in
// sidepanel.html so "Clear & start over" returns the tab to a clean slate.
const KW_BODY_HINT =
  '<p class="hint">On the Amazon Merch upload page? Upload your art, hit “Use the design on this page,” and it’ll read the file, validate keywords against Amazon autosuggest, fill your listing fields, and trademark-check them. Or choose a file manually.</p>';

/** Discard the current design + all run output (analysis, keywords, listing,
 *  trademark) and return the Keywords tab to its initial state. No-op mid-run so
 *  it can't wipe state under a live pipeline. */
export function clearKwRun(): void {
  if (kw.busy) return;
  kwRunId++; // invalidate any in-flight keyword screen
  stopQuips();
  hideTmPopup();
  kw.imageBase64 = null;
  kw.analysis = null;
  kw.validated = [];
  trademarkedWords = new Map();
  tmScreenState = 'idle';
  tmScreenStale = false;
  rankingSkipped = false;
  kw.listing = null;
  kw.trademark = null;
  kw.trademarkError = null;
  const preview = el('kw-preview') as HTMLImageElement;
  preview.hidden = true;
  preview.removeAttribute('src');
  const empty = document.getElementById('kw-preview-empty');
  if (empty) empty.hidden = false; // restore the clickable "Choose image" slot
  const file = document.getElementById('kw-file') as HTMLInputElement | null;
  if (file) file.value = ''; // let the same file re-trigger 'change' if re-picked
  kwGrabNote('');
  el('kw-body').innerHTML = KW_BODY_HINT;
  kwUpdateGenerateEnabled();
  forgetLastRun();
}

export async function kwGrabFromPage(): Promise<void> {
  const btn = el('kw-grab') as HTMLButtonElement;
  const id = await activeTabId();
  if (id == null) {
    kwGrabNote("Can't reach this tab.");
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Looking for your design…';
  kwGrabNote('');
  try {
    const resp = await new Promise<any>((resolve) => {
      try {
        chrome.tabs.sendMessage(id, { type: 'cmd', action: 'grab-design' }, (r: any) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      } catch {
        resolve(null);
      }
    });
    if (resp?.ok && typeof resp.dataUrl === 'string') {
      kwSetImage(resp.dataUrl);
      kwGrabNote(
        kwHasCreds()
          ? 'Loaded your design. Hit Generate (auto), or Analyze to pick keywords yourself.'
          : resp.source === 'upload'
            ? 'Loaded the design you uploaded. Add your API key in ⚙, then Generate or Analyze.'
            : 'Loaded a design from this page. Add your API key in ⚙, then Generate or Analyze.'
      );
    } else if (resp === null) {
      kwGrabNote('Reload the page (F5) so the extension can read it, then try again.');
    } else {
      kwGrabNote("No uploaded design found here. Upload your artwork first, or choose a file below.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label || '📥 Use the design on this page';
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loading quips — rotating, slightly unhinged status lines so the waits feel
// alive instead of a dead "Loading…". Two themed decks: one for the
// analysis/generation pipeline, one for the trademark screen. The real phase
// still shows as a small subline (and the autosuggest %), so nothing
// informative is lost — the quip is just the fun headline on top.
// ---------------------------------------------------------------------------

const ANALYZE_QUIPS: readonly string[] = [
  'Squinting at your masterpiece…',
  'Teaching the AI some taste…',
  'Reading the design’s aura…',
  'Channeling your inner shopper…',
  'Dreaming up keywords…',
  'Asking Amazon what people actually type…',
  'Sorting the bangers from the filler…',
  'Wordsmithing your listing…',
  'Sprinkling on the SEO fairy dust…',
  'Making it impossible to scroll past…',
  'Bribing the algorithm…',
  'Untangling the keyword spaghetti…',
  'Convincing shoppers they need this…',
  'Manifesting page-one rankings…',
  'Cramming in every long-tail keyword…',
  'Whispering sweet nothings to the A9 algorithm…',
  'Counting the ways to say “cool shirt”…',
  'Peeking at your competitors’ listings…',
  'Negotiating with the SEO gods…',
  'Translating vibes into search terms…',
  'Polishing the title until it shines…',
  'Stuffing the bullets (tastefully)…',
  'Hunting for buyer-intent gold…',
  'Decoding what the people want…',
  'Brewing a fresh batch of keywords…',
  'Auditioning adjectives for the title…',
  'Out-optimizing your competition…',
  'Turning your design into a sales magnet…',
  'Doing keyword cardio…',
  'Summoning the conversion fairies…',
];

const SCREEN_QUIPS: readonly string[] = [
  'Lawyering up your keywords…',
  'Raiding the trademark vault…',
  'Making sure nobody owns these words…',
  'Frisking each keyword for ™ trouble…',
  'Consulting the US registry…',
  'Cross-checking the ™ blacklist…',
  'Sniffing out brand landmines…',
  'Scanning for billion-dollar brand names…',
  'Patrolling for protected phrases…',
  'Double-checking nobody trademarked “vibes”…',
  'Running the registry gauntlet…',
];

let quipTimer: ReturnType<typeof setInterval> | null = null;

/** Rotate `quips` through the element matched by `selector` (inside kw-body)
 *  every few seconds. Starts on a random line so repeated runs feel fresh. */
function startQuips(selector: string, quips: readonly string[]): void {
  stopQuips();
  let i = Math.floor(Math.random() * quips.length);
  const tick = () => {
    const node = el('kw-body').querySelector(selector) as HTMLElement | null;
    if (!node) return; // body repainted out from under us — renderResults handles restart
    node.textContent = quips[i % quips.length];
    i++;
  };
  tick();
  quipTimer = setInterval(tick, 2600);
}

function stopQuips(): void {
  if (quipTimer != null) {
    clearInterval(quipTimer);
    quipTimer = null;
  }
}

/** Pipeline loading state: a rotating funny quip headline + a small real-phase
 *  subline (built once, then only the subline updates so the quip keeps cycling
 *  smoothly across phase changes). */
function setStatus(msg: string): void {
  const body = el('kw-body');
  let sub = body.querySelector('.loading-sub') as HTMLElement | null;
  if (!sub) {
    body.innerHTML =
      '<div class="loading"><div class="spin"></div>' +
      '<div class="loading-txt"><span class="loading-quip"></span>' +
      '<span class="loading-sub"></span></div></div>';
    startQuips('.loading-quip', ANALYZE_QUIPS);
    sub = body.querySelector('.loading-sub') as HTMLElement | null;
  }
  if (sub) sub.textContent = msg;
}

/** Map the auto-pipeline's semantic phases to the exact loading sublines the
 *  Keywords tab showed before the orchestration moved into core. */
function pipelinePhaseStatus(phase: PipelinePhase, detail?: PipelineProgress): void {
  switch (phase) {
    case 'analyze':
      setStatus('Analyzing the design…');
      break;
    case 'generate':
      setStatus('Generating keyword ideas…');
      break;
    case 'validate':
      setStatus(
        detail?.progress != null
          ? `Checking Amazon autosuggest… ${detail.progress}%`
          : 'Checking Amazon autosuggest…'
      );
      break;
    case 'rank':
      setStatus('Ranking validated keywords…');
      break;
    case 'listing':
      setStatus('Writing the listing…');
      break;
    case 'trademark':
      if (detail?.status) setStatus(detail.status);
      break;
  }
}

/** Manual analyze flow reporter: same sublines as the auto reporter, but the rank
 *  subline keeps its shorter wording (the listing/trademark phases don't occur). */
function analyzePhaseStatus(phase: PipelinePhase, detail?: PipelineProgress): void {
  switch (phase) {
    case 'analyze':
      setStatus('Analyzing the design…');
      break;
    case 'generate':
      setStatus('Generating keyword ideas…');
      break;
    case 'validate':
      setStatus(
        detail?.progress != null
          ? `Checking Amazon autosuggest… ${detail.progress}%`
          : 'Checking Amazon autosuggest…'
      );
      break;
    case 'rank':
      setStatus('Ranking keywords…');
      break;
    default:
      break;
  }
}

function promptForAiCredentials(): void {
  stopQuips();
  kwGrabNote('Add an API key in ⚙ settings, or choose "My AI subscription" and start the helper (`iscale helper`).');
  const panel = document.getElementById('kw-settings-panel') as HTMLElement | null;
  if (panel) panel.hidden = false;
  const keyInput = document.getElementById('kw-key') as HTMLInputElement | null;
  keyInput?.focus();
}

export async function runPipeline(): Promise<void> {
  await applyTrademarkApiKey();
  if (!kw.imageBase64 || kw.busy) return;
  if (!kwHasCreds()) {
    promptForAiCredentials();
    return;
  }
  kw.busy = true;
  kwRunId++;
  rankingSkipped = false;
  kwUpdateGenerateEnabled();
  kw.trademark = null;
  kw.trademarkError = null;
  const ai = kwAiConfig();
  try {
    const result = await runListingPipeline(
      {
        imageBase64: kw.imageBase64,
        aiConfig: ai,
        config: kw.config,
        validateEnabled: kw.validateEnabled,
        trademarkEnabled: kw.trademarkEnabled,
      },
      { autosuggest: autosuggestFetcher, onPhase: pipelinePhaseStatus }
    );
    kw.analysis = result.analysis;
    kw.validated = result.validated;
    kw.listing = result.listing;
    kw.trademark = result.trademark;
    kw.trademarkError = result.trademarkError;
    rankingSkipped = result.rankingSkipped;
    renderResults();
    void screenKeywords(); // flag any trademarked keywords red (non-blocking)
    // Hands-off Auto on a connected site: push the finished listing straight onto
    // the page, so the whole flow (read design → listing → fill) needs no clicks.
    // But only when trademark screening didn't fail and the listing is clean —
    // never auto-fill unscreened or still-flagged copy into the live editor.
    const tmSafe = isTrademarkSafeForAutofill(result.trademark, result.trademarkError, kw.trademarkEnabled);
    if (kw.site === 'amazon-merch' && kw.runMode === 'auto' && tmSafe) void fillMerchPage();
  } catch (e) {
    stopQuips();
    el('kw-body').innerHTML = `<div class="err"><strong>Couldn't generate.</strong><p>${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
  } finally {
    kw.busy = false;
    kwUpdateGenerateEnabled();
  }
}

/** Manual mode: analyze + validate, then STOP so the user picks keywords before the
 *  listing is written. (Auto = runPipeline does everything in one shot.) */
export async function runAnalyze(): Promise<void> {
  await applyTrademarkApiKey();
  if (!kw.imageBase64 || kw.busy) return;
  if (!kwHasCreds()) {
    promptForAiCredentials();
    return;
  }
  kw.busy = true;
  kwRunId++;
  rankingSkipped = false;
  kwUpdateGenerateEnabled();
  kw.listing = null;
  kw.trademark = null;
  kw.trademarkError = null;
  const ai = kwAiConfig();
  try {
    const { analysis, ranked, rankingSkipped: skipped } = await generateKeywords(
      {
        imageBase64: kw.imageBase64,
        aiConfig: ai,
        config: kw.config,
        validateEnabled: kw.validateEnabled,
      },
      { autosuggest: autosuggestFetcher, onPhase: analyzePhaseStatus }
    );
    kw.analysis = analysis;
    rankingSkipped = skipped;
    kw.validated = ranked.map((k) => ({ ...k, selected: false }));
    renderResults(); // manual category picker — user chooses, nothing pre-selected
    void screenKeywords(); // then flag trademarked pills red as the screen returns
  } catch (e) {
    stopQuips();
    el('kw-body').innerHTML = `<div class="err"><strong>Couldn't analyze.</strong><p>${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
  } finally {
    kw.busy = false;
    kwUpdateGenerateEnabled();
  }
}

/** Generate the listing from the current selection, then optional trademark pass.
 *  Delegates the listing + trademark + max-fill glue to the shared core
 *  `produceListing`; here we only map phases to the loading subline and commit the
 *  result to `kw`. */
async function generateAndCheck(ai: AIConfig, status: string): Promise<void> {
  const result = await produceListing(
    {
      aiConfig: ai,
      config: kw.config,
      validated: kw.validated,
      detectedText: kw.analysis?.detectedText,
      trademarkEnabled: kw.trademarkEnabled,
    },
    {
      onPhase: (phase, detail) => {
        if (phase === 'listing') setStatus(status);
        else if (phase === 'trademark' && detail?.status) setStatus(detail.status);
      },
    }
  );
  kw.listing = result.listing;
  kw.trademark = result.trademark;
  kw.trademarkError = result.trademarkError;
  renderResults();
}

function appendSelectedKeywordsToListing(): boolean {
  if (!kw.listing) return false;
  const { listing, finalListing } = appendKeywordsToListing({
    listing: kw.listing,
    trademark: kw.trademark,
    keywords: kw.validated,
    config: kw.config,
  });
  if (kw.trademark && finalListing) kw.trademark.finalListing = finalListing;
  else kw.listing = listing;
  return true;
}

/** Update listing output from the current selected keywords. Existing listings
 *  use a fast append-only pass; the expensive AI rewrite runs only for the first
 *  listing or when no listing is available yet. */
export async function regenerate(): Promise<void> {
  await applyTrademarkApiKey();
  if (!kw.analysis || kw.busy) return;
  if (kw.listing) {
    appendSelectedKeywordsToListing();
    renderResults();
    return;
  }
  if (!kwHasCreds()) {
    promptForAiCredentials();
    return;
  }
  kw.busy = true;
  kwUpdateGenerateEnabled();
  const ai = kwAiConfig();
  try {
    await generateAndCheck(ai, 'Writing listing…');
  } catch (e) {
    stopQuips();
    el('kw-body').innerHTML = `<div class="err"><strong>Couldn't regenerate.</strong><p>${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
  } finally {
    kw.busy = false;
    kwUpdateGenerateEnabled();
  }
}

/** Run the trademark check on the current listing (manual button). */
async function runTrademark(): Promise<void> {
  if (!kw.listing || kw.busy) return;
  if (!kwHasCreds()) {
    promptForAiCredentials();
    return;
  }
  kw.busy = true;
  const ai = kwAiConfig();
  setStatus('Trademark-checking the listing…');
  try {
    const trademarkJurisdictions = await loadJurisdictions();
    kw.trademark = await trademarkCheckAndRewrite(
      kw.listing,
      kw.validated,
      { ...kw.config, trademarkJurisdictions },
      ai,
      setStatus
    );
    kw.trademarkError = null;
  } catch (e) {
    kw.trademark = null;
    kw.trademarkError = e instanceof Error ? e.message : String(e);
  } finally {
    kw.busy = false;
    renderResults();
  }
}

function toggleSelect(id: string): void {
  kw.validated = kw.validated.map((k) => (k.id === id ? { ...k, selected: !k.selected } : k));
  renderResults();
  kwUpdateGenerateEnabled();
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

/** Trademark-clean content for a field (falls back to pre-check text). */
function fieldContent(fieldId: string, fallback: string): string {
  return kw.trademark?.finalListing?.[fieldId] ?? fallback;
}

/** Wrap used keywords in the field text with <mark> (website HighlightedText). */
function highlight(text: string, keywords: string[]): string {
  if (!keywords.length) return esc(text);
  const sorted = [...keywords].sort((a, b) => b.length - a.length).map(escapeRegex);
  const re = new RegExp(`(${sorted.map((k) => `\\b${k}\\b`).join('|')})`, 'gi');
  return text
    .split(re)
    .map((part) =>
      keywords.some((k) => k.toLowerCase() === part.toLowerCase())
        ? `<mark class="kw-hl">${esc(part)}</mark>`
        : esc(part)
    )
    .join('');
}

/** Manual mode: button to write the listing from the picked keywords. Shown only
 *  before a listing exists; once it runs, the normal Regenerate flow takes over. */
function manualGenerateHtml(): string {
  if (!kw.validated.length || kw.listing) return '';
  const n = kw.validated.filter((k) => k.selected).length;
  return `<button id="kw-gen-listing" class="scan" style="width:100%;margin:0 0 12px"${n ? '' : ' disabled'}>Generate listing from ${n} selected →</button>`;
}

// ---------------------------------------------------------------------------
// Merch by Amazon autofill — push the finished, trademark-clean listing into the
// real Merch product-editor fields on the active tab. The content script
// (duo.ts) owns the page selectors + React-safe writes; here we just map our
// generic fields to Merch's and message the tab.
// ---------------------------------------------------------------------------

/** Send a cmd to the active tab's content script; null if it can't be reached. */
async function sendToActiveTab<T>(action: string, extra?: Record<string, unknown>): Promise<T | null> {
  const id = await activeTabId();
  if (id == null) return null;
  return new Promise<T | null>((resolve) => {
    try {
      chrome.tabs.sendMessage(id, { type: 'cmd', action, ...extra }, (r: T) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Map the generated (trademark-clean) listing fields to Merch's fixed fields.
 *  Bullets fill in order; a description is composed if the layout has none. */
function buildMerchValues(): Record<string, string> {
  const values: Record<string, string> = {};
  let bulletN = 0;
  for (const f of kw.listing?.fields ?? []) {
    const content = fieldContent(f.fieldId, f.content).trim();
    if (!content) continue;
    // Field→Merch mapping lives in scan-core (unit-tested); bullets are classified
    // before description so "Bullet Point Description" doesn't swallow both bullets.
    switch (classifyMerchField(f.fieldId, f.fieldName)) {
      case 'title':
        values['title'] = content;
        break;
      case 'brand':
        values['brand'] = content;
        break;
      case 'bullet':
        bulletN++;
        if (bulletN === 1) values['bullet1'] = content;
        else if (bulletN === 2) values['bullet2'] = content;
        break;
      case 'description':
        values['description'] = content;
        break;
    }
  }
  if (!values['description']) {
    const parts = [values['title'], values['brand'], values['bullet1'], values['bullet2']].filter(Boolean);
    if (parts.length) values['description'] = parts.join(' ');
  }
  return values;
}

/** Keep the manual Amazon fill action available whenever it can help. Editor
 *  detection only tunes the tooltip; the button stays visible so a brittle
 *  selector cannot strand generated fields in the side panel. */
async function refreshMerchButton(): Promise<void> {
  const btn = document.getElementById('kw-fill-merch') as HTMLButtonElement | null;
  if (!btn) return;
  btn.hidden = kw.site !== 'amazon-merch' || !kw.listing;
  if (btn.hidden) return;
  const r = await sendToActiveTab<{ merch?: boolean }>('merch-detect');
  btn.title = r?.merch
    ? 'Fill the active Amazon Merch listing editor'
    : 'Open the Amazon Merch listing editor tab, then press to fill';
}

async function fillMerchPage(): Promise<void> {
  if (!kw.listing) return;
  const note = document.getElementById('kw-fill-merch-note');
  const resp = await sendToActiveTab<{ ok: boolean; filled: string[]; missing: string[] }>('fill-listing', {
    values: buildMerchValues(),
  });
  if (!note) return;
  note.hidden = false;
  if (!resp) note.textContent = 'Open your Merch product page (the listing editor) in the active tab, then try again.';
  else if (!resp.ok) note.textContent = 'No Merch listing fields found on this page. Open the Amazon Merch listing editor, then press Fill again.';
  else note.textContent = `✓ Filled ${resp.filled.length} field${resp.filled.length === 1 ? '' : 's'} on the Merch page.`;
}

/** "Connect" to the selected site on the active tab: confirm we're on its page,
 *  then auto-read the uploaded design so the user needn't click Grab. 'none'
 *  clears the status and changes nothing (manual flow). Safe to call repeatedly
 *  — it only grabs when there's no image yet. */
export async function connectSite(): Promise<void> {
  const status = document.getElementById('kw-site-status');
  const setStatus = (text: string, cls: string) => {
    if (!status) return;
    status.textContent = text;
    status.className = `kw-site-status ${cls}`;
    status.hidden = false;
  };
  if (kw.site !== 'amazon-merch') {
    if (status) status.hidden = true;
    return;
  }
  const r = await sendToActiveTab<{ merch?: boolean }>('merch-detect');
  if (!r || !r.merch) {
    setStatus('○ Open your Amazon Merch upload page', 'kw-site-off');
    return;
  }
  if (kw.imageBase64) {
    setStatus('● Connected to Amazon Merch', 'kw-site-on');
    return;
  }
  setStatus('● Connected — reading your design…', 'kw-site-on');
  await kwGrabFromPage();
  if (!kw.imageBase64) {
    setStatus('● Connected — upload your art and it’ll read it', 'kw-site-on');
    return;
  }
  // Hands-off: in Auto mode, run the whole pipeline on the freshly read design
  // (skip if it can't run yet, or a run already happened — the guards below also
  // stop a focus re-connect from re-triggering once results exist).
  if (
    kw.runMode === 'auto' &&
    kwHasCreds() &&
    !kw.busy &&
    !kw.validated.length &&
    !kw.listing &&
    kw.imageBase64 !== autoRanForImage
  ) {
    autoRanForImage = kw.imageBase64;
    setStatus('● Connected — generating your listing…', 'kw-site-on');
    void runPipeline();
    return;
  }
  setStatus('● Connected to Amazon Merch', 'kw-site-on');
}

function listingHtml(): string {
  if (!kw.listing) return '';
  const rows = kw.listing.fields
    .map((f, i) => {
      const content = fieldContent(f.fieldId, f.content);
      const len = content.length;
      const pct = f.maxChars ? Math.min(100, Math.round((len / f.maxChars) * 100)) : 0;
      const tight = len > f.maxChars - 5;
      return `<div class="kw-field">
        <div class="kw-field-h">
          <span class="kw-field-name">${esc(f.fieldName)}</span>
          <span class="kw-field-count ${tight ? 'kw-ok' : ''}">${len}/${f.maxChars}</span>
          <button class="kw-field-copy" data-copyfield="${i}" title="Copy this field">📋 Copy</button>
        </div>
        <div class="kw-field-body">${highlight(content, f.keywordsUsed)}</div>
        <div class="kw-bar"><span style="width:${pct}%"></span></div>
      </div>`;
    })
    .join('');
  const merchFill = kw.site === 'amazon-merch'
    ? `<button id="kw-fill-merch" class="kw-grab" style="width:100%;margin:10px 0 0">⤵ Fill Amazon Merch page</button>
    <p class="tip" id="kw-fill-merch-note" hidden style="margin:6px 0 0"></p>`
    : '';
  return `<div class="kw-section-h">Listing fields
      <span class="kw-copy" id="kw-copyfields">Copy all</span>
      <span class="kw-copy" id="kw-export">Export JSON</span>
      <span class="kw-copy" id="kw-regen">+ Add Keywords</span></div>${rows}
    ${merchFill}`;
}

// ---------------------------------------------------------------------------
// "Ban" a trademark from a result: it goes on the banned-words list (shared with
// the CLI), so future listings never use it and never need a trademark rewrite.
// ---------------------------------------------------------------------------

function isBanned(term: string): boolean {
  const t = term.trim().toLowerCase();
  return kw.config.forbiddenWords.some((w) => w.trim().toLowerCase() === t);
}

function banMark(mark: Omit<BannedTrademark, 'addedAt'>): void {
  kw.config = banTrademark(kw.config, mark);
  kwSaveSettings();
  renderConfigEditor();
  renderResults();
}

function banButtonHtml(term: string, attr: string): string {
  if (isBanned(term)) return '<span class="kw-ban-done">✓ banned</span>';
  const oneWord = !/\s/.test(term.trim());
  const title = oneWord
    ? `Add “${term}” to banned words — it will never be used in ANY listing (a single word, so this is broad)`
    : `Add “${term}” to banned words — future listings never use it`;
  return `<button class="kw-ban-btn" ${attr} title="${escAttr(title)}">Ban</button>`;
}

/** Pills for every mark the trademark step took out, each with a Ban button. */
function flaggedMarksHtml(): string {
  const marks = kw.trademark?.flaggedMarks ?? [];
  if (!marks.length) return '';
  const pills = marks
    .map((m, i) => {
      const meta = [m.jurisdiction, m.international_class && `class ${m.international_class}`, m.registration_status]
        .filter(Boolean)
        .join(' · ');
      const who = m.owner ? ` — ${m.owner}` : '';
      return `<span class="kw-tmmark" title="${escAttr(`${m.wordmark}${who}`)}"><strong>${esc(m.term)}</strong> <span class="kw-tmmark-meta">${esc(m.wordmark)} · ${esc(meta)}</span> ${banButtonHtml(m.term, `data-ban-mark="${i}"`)}</span>`;
    })
    .join('');
  return `<div class="kw-tmmarks"><div class="kw-tmmarks-h">Trademarked words taken out — ban them so future listings never use them:</div>${pills}</div>`;
}

function trademarkHtml(): string {
  if (kw.trademarkError) {
    return `<div class="kw-tm kw-tm-warn">⚠ Trademark check failed — ${esc(kw.trademarkError)}.
      <span class="kw-copy" id="kw-tm-run">Retry</span></div>`;
  }
  const tm = kw.trademark;
  if (!tm) {
    if (!kw.listing) return '';
    return `<div class="kw-tm kw-tm-idle">Trademark check ${kw.trademarkEnabled ? 'on' : 'off'}.
      <span class="kw-copy" id="kw-tm-run">Run check</span></div>`;
  }
  const changes = tm.changes
    .map(
      (c) =>
        `<li><span class="kw-tm-was">${esc(c.original)}</span> → <strong>${esc(c.replacement)}</strong> <span class="kw-tm-why">(${esc(c.reason)})</span></li>`
    )
    .join('');
  let head: string;
  if (tm.stale)
    head = `⚠ Trademark DB is updating — the listing could NOT be definitively cleared. Re-check before publishing.`;
  else if (tm.clean && tm.changes.length === 0) head = '✓ Trademark clear (US + EU)';
  else if (tm.clean) head = `✓ Rewritten to remove: ${esc(tm.flaggedTerms.join(', '))}`;
  else head = `⚠ Still flags after ${tm.iterations} passes: ${esc(tm.flaggedTerms.join(', '))}. Review before listing.`;
  return `<div class="kw-tm ${tm.clean ? 'kw-tm-ok' : 'kw-tm-warn'}">${head}
    <span class="kw-copy" id="kw-tm-run">Re-run</span>
    ${changes ? `<ul class="kw-tm-list">${changes}</ul>` : ''}${flaggedMarksHtml()}</div>`;
}

/** The phrase a pill's 🔍 searches: the keyword + the product word it certified
 *  under (bestVariant), falling back to the primary configured variant, then the
 *  bare keyword. Mirrors how validation queried Amazon ("cat mom" → "cat mom shirt"). */
function searchQueryFor(k: ValidatedKeyword): string {
  const variant = k.bestVariant || kw.config.productVariants[0] || '';
  return variant ? `${k.word} ${variant}` : k.word;
}

/** Open the keyword's Amazon search results in a new tab. */
function openAmazonSearch(k: ValidatedKeyword): void {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(searchQueryFor(k))}`;
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

/** Wrap each word-boundaried occurrence of the trademarked text inside the
 *  keyword in a red span — so "animal lovers" flags only "animal", not the whole
 *  phrase. Falls back to the plain (escaped) keyword if it doesn't appear. */
function highlightTrademarkedWord(word: string, matchedText: string): string {
  const mt = matchedText.trim();
  if (!mt) return esc(word);
  const re = new RegExp(`\\b${escapeRegex(mt)}\\b`, 'gi');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(word)) !== null) {
    out += esc(word.slice(last, m.index)) + `<span class="kw-tm-word">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches
  }
  out += esc(word.slice(last));
  return out === esc(word) ? esc(word) : out;
}

function chipHtml(k: ValidatedKeyword, selected: boolean): string {
  const tm = trademarkedWords.get(k.word.toLowerCase());
  // The pill keeps its normal certified/uncertified color; only the trademarked
  // WORD inside turns red (flagged pills are marked for the hover popup).
  // "unverified" = validation ran but every Amazon autosuggest call for this
  // keyword errored, so its uncertified state is "couldn't check", not a real
  // miss. Mark it so the user doesn't read a rate-limited keyword as rejected.
  const unverified = !k.certified && k.unverified === true;
  const cls = selected
    ? k.certified
      ? 'kw-chip-sel-cert'
      : 'kw-chip-sel-un'
    : k.certified
      ? 'kw-chip-av-cert'
      : 'kw-chip-av-un';
  const mark = selected ? ' ×' : '';
  // No autosuggest "#N under variant" tooltip — it was near-always "#1" noise.
  // Flagged pills show the trademark popup instead (no native tooltip).
  const title = tm
    ? ''
    : unverified
      ? "Couldn't verify on Amazon (autosuggest didn't respond) — not certified either way"
      : selected
        ? 'Click to remove'
        : 'Click to add';
  const wordHtml = tm ? highlightTrademarkedWord(k.word, tm.matched_text) : esc(k.word);
  const search = `<button class="kw-chip-search" data-search="${escAttr(k.id)}" title="Search “${escAttr(searchQueryFor(k))}” on Amazon" aria-label="Search on Amazon">🔍</button>`;
  // Clickable ™ badge — opens the trademark detail popup (with a link to the
  // official record). Replaces the old hover-only tooltip.
  const tmBtn = tm
    ? `<button class="kw-tm-btn" data-tm="${escAttr(k.id)}" title="Trademark details — click for the official record" aria-label="Trademark details">™</button>`
    : '';
  const unvCls = unverified && !tm ? ' kw-chip-unverified' : '';
  return `<span class="kw-chip ${cls}${tm ? ' kw-chip-flagged' : ''}${unvCls}" data-toggle="${escAttr(k.id)}" title="${escAttr(title)}">${wordHtml}${tmBtn}${search}${mark}</span>`;
}

// ---------------------------------------------------------------------------
// Trademark hover popup — full match info (owner, status, class, serial) for a
// red (trademarked) pill. One reusable card on <body>, positioned over the pill.
// ---------------------------------------------------------------------------

let tmPopupEl: HTMLElement | null = null;
let tmDismissWired = false;

function tmPopup(): HTMLElement {
  if (!tmPopupEl) {
    tmPopupEl = document.createElement('div');
    tmPopupEl.className = 'kw-tm-popup';
    tmPopupEl.hidden = true;
    document.body.appendChild(tmPopupEl);
  }
  // Dismiss when clicking outside the popup / any ™ badge, or on Escape. Wired
  // once (module-level) so re-renders don't stack duplicate listeners.
  if (!tmDismissWired) {
    tmDismissWired = true;
    document.addEventListener('click', (e) => {
      if (!tmPopupEl || tmPopupEl.hidden) return;
      const t = e.target as HTMLElement;
      if (!tmPopupEl.contains(t) && !t.closest('[data-tm]')) hideTmPopup();
    });
    document.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') hideTmPopup();
    });
  }
  return tmPopupEl;
}

/** Toggle the popup for a pill: open it, or close it if it's already showing it. */
function toggleTmPopup(anchor: HTMLElement, m: TrademarkMatch, id: string, keyword?: string): void {
  const pop = tmPopup();
  if (!pop.hidden && pop.dataset['for'] === id) {
    hideTmPopup();
    return;
  }
  showTmPopup(anchor, m, keyword);
  pop.dataset['for'] = id;
}

function showTmPopup(anchor: HTMLElement, m: TrademarkMatch, keyword?: string): void {
  // tsdr_url + jurisdiction come back from the trademark API at runtime (the core
  // type doesn't declare them); fall back to building the USPTO link from serial.
  const ext = m as TrademarkMatch & { tsdr_url?: string; jurisdiction?: string; status?: string };
  const pop = tmPopup();
  // "Live/Dead" (is the mark active?) and "Pending/Registered" (lifecycle stage)
  // are different axes — a mark can be LIVE *and* pending. Show both so it matches
  // the official record (which prominently shows "Live") instead of looking wrong.
  const reg = m.registration_status || 'pending';
  const stage = reg.charAt(0).toUpperCase() + reg.slice(1);
  const live = (ext.status || '').toUpperCase();
  const status = live === 'LIVE' ? `Live · ${stage}` : live === 'DEAD' ? `Dead · ${stage}` : stage;
  const jur = ext.jurisdiction || 'US';
  const url = trademarkRecordUrl({ jurisdiction: jur, serial_number: m.serial_number, tsdr_url: ext.tsdr_url });
  const row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  pop.innerHTML =
    '<button class="kw-tm-popup-x" aria-label="Close">×</button>' +
    '<div class="kw-tm-popup-h">⚠ Possible trademark</div>' +
    `<div class="kw-tm-popup-mark">${esc(m.wordmark)}</div>` +
    '<dl class="kw-tm-popup-dl">' +
    (m.owner ? row('Owner', m.owner) : '') +
    row('Status', `${status} · ${jur}`) +
    row('Class', m.international_class) +
    row('Serial', m.serial_number) +
    '</dl>' +
    (url
      ? `<a class="kw-tm-popup-link" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">View official record →</a>`
      : '') +
    (reg === 'pending'
      ? '<div class="kw-tm-popup-foot">Pending = a live application, filed but not yet registered.</div>'
      : '') +
    (keyword ? `<div class="kw-tm-popup-ban">${banButtonHtml(keyword, 'data-ban-kw')}</div>` : '');
  pop.hidden = false;
  pop.querySelector('[data-ban-kw]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTmPopup();
    if (!keyword) return;
    banMark({
      term: keyword,
      wordmark: m.wordmark,
      owner: m.owner ?? undefined,
      international_class: m.international_class,
      jurisdiction: ext.jurisdiction || 'US',
      registration_status: m.registration_status,
      serial_number: m.serial_number,
    });
  });
  pop.querySelector('.kw-tm-popup-x')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTmPopup();
  });
  // Prefer above the pill; flip below if it would clip the top. Clamp horizontally.
  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  let top = a.top - p.height - 8;
  if (top < 8) top = a.bottom + 8;
  const left = Math.min(Math.max(8, a.left), window.innerWidth - p.width - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function hideTmPopup(): void {
  if (tmPopupEl) {
    tmPopupEl.hidden = true;
    delete tmPopupEl.dataset['for'];
  }
}

// Manual mode: candidate keywords grouped by category. The 5 W's
// (who/what/where/when/why) lead, then the remaining buckets. Selected pills
// collect in a "Selected" section on top;
// each category lists only its still-unpicked pills (click to add).
const KW_CATS: ReadonlyArray<readonly [string, string]> = [
  ['who', 'Who'],
  ['what', 'What'],
  ['where', 'Where'],
  ['when', 'When'],
  ['why', 'Why'],
  ['visual', 'Visual'],
  ['text', 'Text'],
  ['lsi', 'Related'],
];

function manualPickerHtml(): string {
  if (!kw.validated.length) return '';
  const selected = kw.validated.filter((k) => k.selected);
  const selHtml = selected.length
    ? selected.map((k) => chipHtml(k, true)).join('')
    : '<span class="kw-meta">Click pills below to add them here.</span>';

  const buckets = KW_CATS.map(([src, label]) => {
    const items = kw.validated.filter((k) => !k.selected && k.source === src);
    if (!items.length) return '';
    return `<div class="kw-bucket"><div class="kw-bucket-h">${label} <span class="kw-meta">(${items.length})</span></div>
      <div class="kw-chips">${items.map((k) => chipHtml(k, false)).join('')}</div></div>`;
  });
  // Anything with an unrecognized source still needs a home.
  const known = new Set(KW_CATS.map(([s]) => s));
  const other = kw.validated.filter((k) => !k.selected && !known.has(k.source));
  if (other.length) {
    buckets.push(`<div class="kw-bucket"><div class="kw-bucket-h">More <span class="kw-meta">(${other.length})</span></div>
      <div class="kw-chips">${other.map((k) => chipHtml(k, false)).join('')}</div></div>`);
  }

  return `<div class="kw-section-h">Selected (${selected.length})
      <span class="kw-copy" id="kw-copykw">Copy all</span></div>
    <div class="kw-chips">${selHtml}</div>
    <div class="kw-meta" style="margin:10px 0 4px">Pick keywords by category, then Generate the listing.</div>
    ${buckets.join('')}
    <div class="kw-legend2">
      <span><span class="kw-dot kw-dot-cert"></span>Certified — on Amazon search</span>
      <span><span class="kw-dot kw-dot-un"></span>Not found</span>
      <span><span class="kw-dot kw-dot-tm"></span>Trademarked</span>
    </div>`;
}

function keywordsHtml(): string {
  if (!kw.validated.length) return '';
  const selected = kw.validated.filter((k) => k.selected);
  const available = kw.validated.filter((k) => !k.selected);
  const selHtml = selected.length
    ? selected.map((k) => chipHtml(k, true)).join('')
    : '<span class="kw-meta">None selected — pick from below.</span>';
  const avHtml = available.length
    ? available.map((k) => chipHtml(k, false)).join('')
    : '<span class="kw-meta">All selected.</span>';
  return `<div class="kw-section-h">Keywords (${selected.length} selected, ${available.length} available)
      <span class="kw-copy" id="kw-copykw">Copy all</span></div>
    <div class="kw-sub">In the listing — click to remove</div>
    <div class="kw-chips">${selHtml}</div>
    <div class="kw-sub" style="margin-top:8px">Available — click to add</div>
    <div class="kw-chips">${avHtml}</div>
    <div class="kw-legend2">
      <span><span class="kw-dot kw-dot-cert"></span>Certified — on Amazon search</span>
      <span><span class="kw-dot kw-dot-un"></span>Not found</span>
    </div>
    <div class="kw-meta">Edit the selection, then ↻ Regenerate to rebuild the fields.</div>`;
}

function analysisHtml(): string {
  if (!kw.analysis) return '';
  const a = kw.analysis;
  return `<details class="kw-details"><summary>Design analysis</summary>
    <div class="kw-analysis">
      <strong>Visual:</strong> ${esc(a.visualElements.join(', ') || '—')}<br/>
      ${a.detectedText.length ? `<strong>Text on design:</strong> ${esc(a.detectedText.join(', '))}<br/>` : ''}
      <strong>Style:</strong> ${esc(a.style || '—')} &middot; <strong>Mood:</strong> ${esc(a.mood || '—')}<br/>
      <strong>Colors:</strong> ${esc(a.colors.join(', ') || '—')}
    </div></details>`;
}

function fieldsForCopy(): { name: string; content: string }[] {
  if (!kw.listing) return [];
  return kw.listing.fields.map((f) => ({ name: f.fieldName, content: fieldContent(f.fieldId, f.content) }));
}

/** Build the machine-readable export JSON for the current run, through the SAME
 *  core shaper the CLI uses (so the two surfaces emit identical envelopes). */
function buildKwExportJson(): string {
  const result = buildExportResult({
    analysis: kw.analysis,
    keywords: kw.validated,
    listing: kw.listing,
    trademark: kw.trademark,
    trademarkError: kw.trademarkError,
    appVersion: chrome.runtime?.getManifest?.().version,
    createdAt: new Date().toISOString(),
  });
  return JSON.stringify(result, null, 2);
}

function paintResults(): void {
  // Painting real results ends any pipeline-loading quip rotation. If the
  // trademark screen is still in flight, restart the rotator on its own deck.
  stopQuips();
  hideTmPopup(); // old pill nodes are about to be replaced
  // Manual mode, pre-listing = the category picker (Who/What/Where/When/Why).
  // Once a listing exists (or in Auto), fall back to the selected/available view.
  const picking = kw.runMode === 'manual' && !kw.listing;
  el('kw-body').innerHTML =
    manualGenerateHtml() + trademarkHtml() + listingHtml() + tmScreenHtml() +
    rankWarnHtml() + validateWarnHtml() +
    (picking ? manualPickerHtml() : keywordsHtml()) + analysisHtml();
  if (tmScreenState === 'running') startQuips('.kw-tmscreen-quip', SCREEN_QUIPS);

  document.getElementById('kw-gen-listing')?.addEventListener('click', () => void regenerate());
  document.getElementById('kw-regen')?.addEventListener('click', () => void regenerate());
  document.getElementById('kw-tm-run')?.addEventListener('click', () => void runTrademark());
  for (const node of Array.from(document.querySelectorAll('[data-ban-mark]'))) {
    node.addEventListener('click', () => {
      const m = kw.trademark?.flaggedMarks?.[Number((node as HTMLElement).dataset['banMark'])];
      if (m) banMark(m);
    });
  }
  document.getElementById('kw-fill-merch')?.addEventListener('click', () => void fillMerchPage());
  void refreshMerchButton(); // reveal the Merch-fill button if the active tab is the editor

  for (const node of Array.from(document.querySelectorAll('[data-copyfield]'))) {
    node.addEventListener('click', () => {
      const btn = node as HTMLElement;
      const f = fieldsForCopy()[Number(btn.dataset['copyfield'])];
      if (!f) return;
      void navigator.clipboard?.writeText(f.content);
      const prev = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('kw-copied');
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove('kw-copied');
      }, 1200);
    });
  }
  document.getElementById('kw-copyfields')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(fieldsForCopy().map((f) => `${f.name}: ${f.content}`).join('\n'));
  });
  document.getElementById('kw-export')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(buildKwExportJson());
    const btn = document.getElementById('kw-export');
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = '✓ Copied JSON';
    btn.classList.add('kw-copied');
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove('kw-copied');
    }, 1200);
  });
  document.getElementById('kw-copykw')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(kw.validated.filter((k) => k.selected).map((k) => k.word).join(', '));
  });
  for (const chip of Array.from(document.querySelectorAll('[data-toggle]'))) {
    chip.addEventListener('click', () => toggleSelect((chip as HTMLElement).dataset['toggle']!));
  }
  for (const node of Array.from(document.querySelectorAll('[data-search]'))) {
    node.addEventListener('click', (e) => {
      e.stopPropagation(); // search the keyword — don't also toggle the pill's selection
      const k = kw.validated.find((v) => v.id === (node as HTMLElement).dataset['search']);
      if (k) openAmazonSearch(k);
    });
  }
  // Flagged (trademarked) pills: click the ™ badge to open the detail popup
  // (which carries a link to the official record). Click again / outside / Esc closes.
  for (const node of Array.from(document.querySelectorAll('[data-tm]'))) {
    node.addEventListener('click', (e) => {
      e.stopPropagation(); // open details — don't also toggle the pill's selection
      const id = (node as HTMLElement).dataset['tm']!;
      const k = kw.validated.find((v) => v.id === id);
      const m = k && trademarkedWords.get(k.word.toLowerCase());
      if (!m) return;
      const anchor = (node as HTMLElement).closest('.kw-chip') as HTMLElement | null;
      toggleTmPopup(anchor ?? (node as HTMLElement), m, id, k.word.toLowerCase());
    });
  }
  kwUpdateGenerateEnabled();
}

// ---------------------------------------------------------------------------
// The last run survives the panel closing, a reload or a self-update. It is
// only replaced by a new run or wiped by "Clear & start over" (Jose
// 2026-10-04: "they should never dissapear on their own").
// ---------------------------------------------------------------------------
const KW_LAST_RUN = 'kw_last_run';
const MAX_SAVED_IMAGE = 4_000_000; // characters of data URL; bigger designs keep everything but the preview
let saveRunTimer: ReturnType<typeof setTimeout> | null = null;

interface SavedRun {
  v: 1;
  imageBase64: string | null;
  analysis: typeof kw.analysis;
  validated: typeof kw.validated;
  listing: typeof kw.listing;
  trademark: typeof kw.trademark;
  trademarkError: string | null;
  trademarkedWords: [string, TrademarkMatch][];
  tmScreenState: 'idle' | 'running' | 'done' | 'error';
  rankingSkipped: boolean;
}

/** Paint the results and remember them. */
export function renderResults(): void {
  paintResults();
  if (saveRunTimer) clearTimeout(saveRunTimer);
  saveRunTimer = setTimeout(saveLastRun, 250);
}

function saveLastRun(): void {
  if (!kw.analysis && !kw.validated.length && !kw.listing) return;
  const run: SavedRun = {
    v: 1,
    imageBase64: kw.imageBase64 && kw.imageBase64.length <= MAX_SAVED_IMAGE ? kw.imageBase64 : null,
    analysis: kw.analysis,
    validated: kw.validated,
    listing: kw.listing,
    trademark: kw.trademark,
    trademarkError: kw.trademarkError,
    trademarkedWords: [...trademarkedWords],
    // A screen still running when the panel closed can't resume; show it as not run.
    tmScreenState: tmScreenState === 'running' ? 'idle' : tmScreenState,
    rankingSkipped,
  };
  storageLocalSet({ [KW_LAST_RUN]: run });
}

function forgetLastRun(): void {
  if (saveRunTimer) clearTimeout(saveRunTimer);
  try {
    chrome.storage?.local?.remove?.([KW_LAST_RUN]);
  } catch {
    /* best effort */
  }
}

/** Bring back the last run when the panel opens (never over a live one). */
export function restoreLastRun(): void {
  storageLocalGet([KW_LAST_RUN], (r) => {
    const run = r?.[KW_LAST_RUN] as SavedRun | undefined;
    if (!run || run.v !== 1 || kw.busy || kw.analysis || kw.validated.length || kw.listing) return;
    if (run.imageBase64) kwSetImage(run.imageBase64);
    kw.analysis = run.analysis ?? null;
    kw.validated = Array.isArray(run.validated) ? run.validated : [];
    kw.listing = run.listing ?? null;
    kw.trademark = run.trademark ?? null;
    kw.trademarkError = run.trademarkError ?? null;
    trademarkedWords = new Map(Array.isArray(run.trademarkedWords) ? run.trademarkedWords : []);
    tmScreenState = run.tmScreenState ?? 'idle';
    rankingSkipped = !!run.rankingSkipped;
    paintResults();
    kwUpdateGenerateEnabled();
  });
}

