// iScale Trademark Checker — native side-panel UI.
//
// Runs as Chrome's native side panel (a separate document docked beside the
// page — the browser reflows the page for us, a true side panel). This script
// owns the controls + results list; the page agent (content/duo.ts) does the
// scanning and highlighting. They talk over chrome messaging:
//   panel -> page agent : chrome.tabs.sendMessage(activeTabId, { type:'cmd', ... })
//   page agent -> panel : chrome.runtime.sendMessage({ type:'tm-...' })  (we listen)
//
// Results ACCUMULATE: each match carries its IC class, so each product-type tab
// shows the slice of the accumulated set whose class belongs to that tab.
// Scanning one type never wipes another. Highlights are colored per type, and a
// word flagged in two types renders as a gradient of both (see categories.ts).

import {
  ALL_CATEGORIES,
  ALL_POD,
  categoryTabLabel,
  normalizeClass,
  sameClasses,
  tint,
  trademarkStatusTone,
  typeOfClass,
  type Category,
} from './categories';
import {
  activeTabId,
  DEFAULT_STATUS_VISIBILITY,
  displayMatches,
  escapeHtml,
  escAttr,
  HIDE_SINGLE_KEY,
  JURISDICTION_OPTIONS,
  JURISDICTIONS,
  JURISDICTIONS_KEY,
  normalizeJurisdictions,
  type TrademarkJurisdiction,
  isSingleWord,
  MODE_KEY,
  normalizeStatusVisibility,
  storageGet,
  storageSet,
  STATUS_VISIBILITY_KEY,
  tierOf,
  type ScanMode,
  type StatusVisibility,
  type TrademarkMatch,
} from './shared';
import { initKeywordsTab } from './keywords';
import { kw, kwSaveSettings } from './kw-state';
import { dedupeMatches as dedupe } from './scan-core';

let selectedClasses: string[] = ['025'];
let selectedJurisdictions: TrademarkJurisdiction[] = [...JURISDICTIONS];
let hideSingleWord = true;
let visibleStatuses: StatusVisibility = { ...DEFAULT_STATUS_VISIBILITY };
let scanMode: ScanMode = 'any';
let lastMatches: TrademarkMatch[] = []; // accumulated union across all scans
let lastStale = false;
let lastPartial = false; // the last scan failed on some chunk(s) → results are incomplete

const $ = (id: string) => document.getElementById(id)!;
const bodyEl = () => $('body');

/** Matches belonging to a tab = those whose class is in the tab's class set. */
function matchesForClasses(classes: readonly string[]): TrademarkMatch[] {
  const set = new Set(classes.map(normalizeClass));
  const juris = new Set<string>(selectedJurisdictions);
  return lastMatches.filter(
    (m) => set.has(normalizeClass(m.international_class)) && juris.has(m.jurisdiction ?? 'US')
  );
}

function visibleStatusMatches(matches: readonly TrademarkMatch[]): TrademarkMatch[] {
  return matches.filter((m) => visibleStatuses[trademarkStatusTone(m.registration_status, m.status)]);
}

function hasEveryClass(classes: readonly string[]): boolean {
  const selected = new Set(selectedClasses.map(normalizeClass));
  return classes.every((c) => selected.has(normalizeClass(c)));
}

// One class selection for the whole extension (page scans, selected text,
// listings, keyword pills) and the CLI: it is kw.config.trademarkClasses,
// saved and shared like every other setting.
function setSelectedClasses(classes: readonly string[]): void {
  selectedClasses = Array.from(new Set(classes.map(normalizeClass).filter(Boolean)));
  if (selectedClasses.length === 0) selectedClasses = ['025'];
  kw.config.trademarkClasses = [...selectedClasses];
  kwSaveSettings();
}

// Registry choice (US only / EU only / US + EU). One setting for page scans,
// selection checks and the Keywords pipeline: saved under JURISDICTIONS_KEY
// for the page agent and as kw.config.trademarkJurisdictions for the core.
function sameJurisdictions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((j) => b.includes(j));
}

function setSelectedJurisdictions(next: readonly string[], persist = true): void {
  const clean = normalizeJurisdictions(next);
  const changed = !sameJurisdictions(clean, selectedJurisdictions);
  selectedJurisdictions = clean;
  const configChanged = !sameJurisdictions(normalizeJurisdictions(kw.config.trademarkJurisdictions), clean);
  if (configChanged) kw.config.trademarkJurisdictions = [...clean];
  if (persist) {
    storageSet({ [JURISDICTIONS_KEY]: clean });
    if (configChanged) kwSaveSettings();
  }
  renderJurisdictions();
  if (changed) {
    renderCats();
    renderResults();
    void sendToPage(pageConfig());
  }
}

function renderJurisdictions(): void {
  for (const id of ['juris', 'kw-juris']) {
    const host = document.getElementById(id);
    if (!host) continue;
    host.innerHTML = '';
    for (const opt of JURISDICTION_OPTIONS) {
      const active = sameJurisdictions(opt.value, selectedJurisdictions);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `juris-btn${active ? ' juris-active' : ''}`;
      btn.dataset['juris'] = opt.id;
      btn.textContent = opt.label;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.addEventListener('click', () => setSelectedJurisdictions(opt.value));
      host.appendChild(btn);
    }
  }
}

// Follow another open panel/device's saved selection without echoing sync writes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[JURISDICTIONS_KEY]) return;
  const next = normalizeJurisdictions(changes[JURISDICTIONS_KEY].newValue);
  const configChanged = !sameJurisdictions(normalizeJurisdictions(kw.config.trademarkJurisdictions), next);
  setSelectedJurisdictions(next, false);
  if (configChanged) {
    kw.config.trademarkJurisdictions = [...next];
    kwSaveSettings();
  }
});
// Loaded from storage, adopted from the CLI, or imported: follow it here.
document.addEventListener('kw-classes-changed', () => {
  if (Array.isArray(kw.config.trademarkJurisdictions)) {
    const nextJ = normalizeJurisdictions(kw.config.trademarkJurisdictions);
    if (!sameJurisdictions(nextJ, selectedJurisdictions)) setSelectedJurisdictions(nextJ);
  }
  const next = Array.from(new Set((kw.config.trademarkClasses ?? []).map(normalizeClass).filter(Boolean)));
  if (!next.length || sameClasses(next, selectedClasses)) return;
  selectedClasses = next;
  renderCats();
  renderLegend();
  renderResults();
  void sendToPage(pageConfig());
});

function toggleCategory(c: Category): void {
  if (c.label === 'All POD') {
    setSelectedClasses(sameClasses(selectedClasses, ALL_POD.classes) ? ['025'] : ALL_POD.classes);
    return;
  }

  const selected = new Set(selectedClasses.map(normalizeClass));
  const active = hasEveryClass(c.classes);
  for (const cls of c.classes) {
    const normalized = normalizeClass(cls);
    if (active) selected.delete(normalized);
    else selected.add(normalized);
  }
  setSelectedClasses(selected.size ? Array.from(selected) : c.classes);
}

function selectionLabel(): string {
  if (sameClasses(selectedClasses, ALL_POD.classes)) return 'All POD';
  const activeLabels = ALL_CATEGORIES
    .filter((c) => c.label !== 'All POD' && hasEveryClass(c.classes))
    .map((c) => c.label);
  return activeLabels.length ? activeLabels.join(' + ') : selectedClasses.join(', ');
}

function renderStatusFilters(): void {
  for (const input of Array.from(document.querySelectorAll('#status-filters input[data-status]'))) {
    const status = (input as HTMLInputElement).dataset['status'] as keyof StatusVisibility | undefined;
    if (status) (input as HTMLInputElement).checked = visibleStatuses[status];
  }
}

function pageConfig(): Record<string, unknown> {
  return {
    type: 'cmd',
    action: 'config',
    classes: selectedClasses,
    jurisdictions: selectedJurisdictions,
    hideSingle: hideSingleWord,
    statuses: visibleStatuses,
    mode: scanMode,
  };
}

// ---------------------------------------------------------------------------
// Talk to the page agent in the active tab
// ---------------------------------------------------------------------------

async function sendToPage(msg: Record<string, unknown>): Promise<boolean> {
  const id = await activeTabId();
  if (id == null) return false;
  try {
    await chrome.tabs.sendMessage(id, msg);
    return true;
  } catch {
    // No live page agent here: either a restricted page (chrome://, web store,
    // PDF) or — the common case — the tab hasn't been reloaded since the
    // extension was last reloaded, so its injected agent is orphaned until the
    // next page load. Either way the message had no receiver.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scan watchdog — never let the spinner hang. If the page agent doesn't answer
// (orphaned after an extension reload, hung request, unsupported page), surface
// a clear "reload the page" message instead of spinning on "Starting scan…".
// ---------------------------------------------------------------------------

// Must sit ABOVE the background's per-request fetch timeout (20 s, background.ts)
// plus a little slack — otherwise a single slow chunk in the 15–20 s window would
// trip the watchdog and replace a live scan's UI with "Can't reach this page".
const SCAN_TIMEOUT_MS = 25000;
let scanWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearScanWatchdog(): void {
  if (scanWatchdog != null) {
    clearTimeout(scanWatchdog);
    scanWatchdog = null;
  }
}

/** (Re)arm the watchdog. Each progress ping pushes the deadline out; a terminal
 *  result/error clears it. If it ever fires, the agent went silent. */
function armScanWatchdog(): void {
  clearScanWatchdog();
  scanWatchdog = setTimeout(() => {
    scanWatchdog = null;
    bodyEl().innerHTML = unreachablePageHtml();
  }, SCAN_TIMEOUT_MS);
}

function unreachablePageHtml(): string {
  return `<div class="err"><strong>Can’t reach this page.</strong>
    <p>Reload the page (press F5), then scan again. Tabs that were already open
    when the extension reloaded need a refresh to reconnect.</p>
    <p class="mini">Some pages can’t be scanned at all — Chrome system pages
    (chrome://…), the Web Store, and PDFs.</p></div>`;
}

// ---------------------------------------------------------------------------
// Render: tabs, legend, results
// ---------------------------------------------------------------------------

function renderCats(): void {
  const host = $('cats');
  host.innerHTML = '';
  for (const c of ALL_CATEGORIES) {
    const active = c.label === 'All POD' ? sameClasses(c.classes, selectedClasses) : hasEveryClass(c.classes);
    const count = dedupe(visibleStatusMatches(matchesForClasses(c.classes))).length;
    const btn = document.createElement('button');
    btn.className = `cat${active ? ' cat-active' : ''}`;
    btn.textContent = count > 0 ? `${categoryTabLabel(c)} (${count})` : categoryTabLabel(c);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) {
      btn.style.background = c.color;
      btn.style.borderColor = c.color;
      btn.style.color = '#111';
    } else if (count > 0) {
      // Idle tab that holds results: tint it in its own color so you can see
      // which types you've already searched.
      btn.style.borderColor = c.color;
      btn.style.color = '#111';
      btn.style.background = tint(c.color, 0.18);
    }
    btn.addEventListener('click', () => {
      toggleCategory(c);
      renderCats();
      renderLegend();
      renderResults();
      void sendToPage(pageConfig());
    });
    host.appendChild(btn);
  }
}

function legendSampleColor(): string {
  const activeCategory =
    ALL_CATEGORIES.find((c) => c.label !== 'All POD' && hasEveryClass(c.classes)) ??
    ALL_CATEGORIES.find((c) => c.label !== 'All POD');
  return activeCategory?.color ?? '#39ff14';
}

function renderLegend(): void {
  const host = $('legend');
  const categories = ALL_CATEGORIES.filter((c) => c.label !== 'All POD')
    .map(
      (c: Category) =>
        `<span class="leg"><span class="leg-dot" style="background:${c.color}"></span>${escapeHtml(categoryTabLabel(c))}</span>`
    )
    .join('');
  const sample = legendSampleColor();
  const statuses = [
    `<span class="leg leg-status"><span class="leg-swatch leg-live" style="background:${tint(sample, 0.6)}"></span>Live</span>`,
    `<span class="leg leg-status"><span class="leg-swatch" style="background:${tint(sample, 0.6)};outline:2px dotted ${sample};outline-offset:2px"></span>Pending</span>`,
    `<span class="leg leg-status"><span class="leg-swatch leg-dead" style="text-decoration:line-through 2px ${sample}">Aa</span>Dead/cancelled</span>`,
    `<span class="leg leg-status"><span class="leg-swatch leg-dead" style="text-decoration:underline 3px ${sample};text-underline-offset:2px">Aa</span>Single word only</span>`,
  ].join('');
  host.innerHTML = `${categories}<span class="leg-break"></span>${statuses}`;
}

// ---------------------------------------------------------------------------
// Scan-mode tabs ("Any site" vs "Amazon"). The mode controls WHICH part of the
// page the agent reads; the category tabs control WHICH trademark classes it
// matches. They're independent — both apply on every scan.
// ---------------------------------------------------------------------------

/** Reflect the active scan mode in the tab bar, scan button, and tip line. */
function applyModeUI(): void {
  for (const btn of Array.from(document.querySelectorAll('.modetab'))) {
    btn.classList.toggle('modetab-active', (btn as HTMLElement).dataset['mode'] === scanMode);
  }
  ($('scan') as HTMLButtonElement).textContent =
    scanMode === 'amazon'
      ? 'Scan brand, title & bullets'
      : scanMode === 'etsy'
        ? 'Scan Etsy listings'
        : 'Scan this page';
  const tip = document.querySelector('.tip');
  if (tip) {
    tip.textContent =
      scanMode === 'amazon'
        ? 'Amazon mode checks only the brand, title, and bullet points. Or select any text to check just that.'
        : scanMode === 'etsy'
          ? 'Etsy mode checks only listing cards on the page. Or select any text to check just that.'
        : '…or select any text on the page to check just that. Results add up across types.';
  }
}

/** Switch scan mode, persist it, update the UI, and tell the page agent. */
function setMode(mode: ScanMode): void {
  if (mode === scanMode) return;
  scanMode = mode;
  storageSet({ [MODE_KEY]: scanMode });
  applyModeUI();
  void sendToPage(pageConfig());
}

function wireModeTabs(): void {
  for (const btn of Array.from(document.querySelectorAll('.modetab'))) {
    btn.addEventListener('click', () => {
      const m = (btn as HTMLElement).dataset['mode'];
      if (m === 'any' || m === 'amazon' || m === 'etsy') setMode(m);
    });
  }
}

function wireStatusFilters(): void {
  for (const input of Array.from(document.querySelectorAll('#status-filters input[data-status]'))) {
    input.addEventListener('change', () => {
      const status = (input as HTMLInputElement).dataset['status'] as keyof StatusVisibility | undefined;
      if (!status) return;
      visibleStatuses = { ...visibleStatuses, [status]: (input as HTMLInputElement).checked };
      storageSet({ [STATUS_VISIBILITY_KEY]: visibleStatuses });
      renderCats();
      renderResults();
      void sendToPage({ ...pageConfig(), action: 'rehighlight' });
    });
  }
}

// ---------------------------------------------------------------------------
// Feature tabs: [Trademark] [Keywords] — switch which top-level view is shown.
// Trademark is the panel above; Keywords is the shared keyword pipeline.
// ---------------------------------------------------------------------------

function wireFeatureTabs(): void {
  const tabs = Array.from(document.querySelectorAll('.ftab'));
  for (const t of tabs) {
    t.addEventListener('click', () => {
      const view = (t as HTMLElement).dataset['view'];
      for (const x of tabs) x.classList.toggle('ftab-active', x === t);
      ($('view-trademark') as HTMLElement).hidden = view !== 'trademark';
      ($('view-keywords') as HTMLElement).hidden = view !== 'keywords';
    });
  }
}

// Gear button (header) toggles the keyword provider/API-key panel. Click-away closes it.
function wireSettingsGear(): void {
  const btn = document.getElementById('kw-settings-btn');
  const panel = document.getElementById('kw-settings-panel') as HTMLElement | null;
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  // Capture phase: this runs BEFORE in-panel click handlers (e.g. class pills)
  // re-render and detach their own target node. In the bubble phase the clicked
  // pill is already orphaned, so panel.contains(target) would be false and the
  // panel would wrongly close on every pill toggle.
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (!panel.hidden && target !== btn && !panel.contains(target)) panel.hidden = true;
  }, true);
}

function rowHtml(m: TrademarkMatch): string {
  const tier = tierOf(m);
  const t = typeOfClass(m.international_class);
  if (!t) return '';
  const tone = trademarkStatusTone(m.registration_status, m.status);
  const color = t.color;
  const opacity = tone === 'dead' ? '0.62' : tier === 'faint' ? '0.72' : '1';
  const statusLabel = tone === 'live' ? 'Live' : tone === 'pending' ? 'Pending' : 'Dead/cancelled';
  const liveStyle = tone === 'live' ? 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);' : '';
  const dotStyle = tone === 'live' ? 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.38);' : '';
  return `<div class="row" data-serial="${escAttr(m.serial_number)}" style="border-left-color:${color};${tone === 'pending' ? 'border-left-style:dotted;' : ''}opacity:${opacity};${liveStyle}">
      <div class="rw"${tone === 'dead' ? ' style="text-decoration:line-through"' : ''}><span class="rdot" style="background:${color};${dotStyle}"></span>${escapeHtml(m.wordmark)}</div>
      <div class="rm">${escapeHtml(statusLabel)} &middot; ${escapeHtml(t.label)} &middot; ${escapeHtml(m.jurisdiction ?? 'US')} &middot; Class ${escapeHtml(m.international_class)}${m.owner ? ' &middot; ' + escapeHtml(m.owner) : ''}</div>
    </div>`;
}

function summarize(): string {
  const tabMatches = dedupe(visibleStatusMatches(matchesForClasses(selectedClasses)));
  const hiddenSingle = hideSingleWord ? tabMatches.filter(isSingleWord).length : 0;
  const shown = displayMatches(tabMatches, hideSingleWord).sort((a, b) => {
    // strongest first: high → low → faint, then alphabetical
    const rank = (m: TrademarkMatch) => (tierOf(m) === 'high' ? 0 : tierOf(m) === 'low' ? 1 : 2);
    return rank(a) - rank(b) || a.wordmark.localeCompare(b.wordmark);
  });

  const staleNote = lastStale ? `<p class="stale">⚠ Some data may be stale — treat as unverified.</p>` : '';
  const partialNote = lastPartial
    ? `<p class="stale" style="color:#b42318;background:#fde8e8;border-color:#f1a9a9">⚠ Incomplete scan — part of this page, or one of the trademark regions (US/EU), couldn't be checked. Treat as UNVERIFIED, not clear; scan again.</p>`
    : '';
  const hiddenNote =
    hiddenSingle > 0
      ? `<p class="hidden-note">${hiddenSingle} single-word mark${hiddenSingle === 1 ? '' : 's'} hidden.</p>`
      : '';
  const hiddenStatusCount = dedupe(matchesForClasses(selectedClasses)).length - tabMatches.length;
  const hiddenStatusNote =
    hiddenStatusCount > 0
      ? `<p class="hidden-note">${hiddenStatusCount} mark${hiddenStatusCount === 1 ? '' : 's'} hidden by status filters.</p>`
      : '';

  if (shown.length === 0) {
    const where = `<strong>${escapeHtml(selectionLabel())}</strong>`;
    const none =
      hiddenSingle > 0
        ? `<p class="clear">No multi-word conflicts in ${where}.</p>`
        : `<p class="hint">No results yet for ${where}. Hit “Scan this page”.</p>`;
    return `${partialNote}${none}${hiddenNote}${hiddenStatusNote}`;
  }

  const rows = shown.map(rowHtml).join('');
  return `<div class="count">${shown.length} potential conflict${shown.length === 1 ? '' : 's'}</div>
          ${partialNote}${staleNote}<div class="list">${rows}</div>${hiddenNote}${hiddenStatusNote}`;
}

function renderResults(): void {
  bodyEl().innerHTML = summarize();
  for (const r of Array.from(document.querySelectorAll('.row'))) {
    r.addEventListener('click', () => {
      const serial = (r as HTMLElement).dataset['serial'] ?? '';
      void sendToPage({ type: 'cmd', action: 'focus', serial });
    });
  }
  ($('clear') as HTMLButtonElement).hidden = lastMatches.length === 0;
}

// ---------------------------------------------------------------------------
// Messages from the page agent
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: any) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'tm-progress') {
    armScanWatchdog(); // alive — push the deadline out
    bodyEl().innerHTML = `<div class="loading"><div class="spin"></div><span>Scanning… (${msg.i}/${msg.n})</span></div>`;
  } else if (msg.type === 'tm-checking') {
    armScanWatchdog();
    bodyEl().innerHTML = `<div class="loading"><div class="spin"></div><span>Checking "${escapeHtml(String(msg.text ?? '').slice(0, 40))}"…</span></div>`;
  } else if (msg.type === 'tm-results') {
    clearScanWatchdog();
    lastMatches = (msg.matches ?? []) as TrademarkMatch[];
    lastStale = !!msg.stale;
    lastPartial = !!msg.partial;
    renderCats();
    renderResults();
  } else if (msg.type === 'tm-error') {
    clearScanWatchdog();
    if (msg.kind === 'rate') {
      bodyEl().innerHTML = `<div class="err"><strong>Rate limited.</strong><p>This page is large — too many checks in a short time. Wait ${Number(msg.retryAfter) || 30}s and scan again.</p></div>`;
    } else if (msg.kind === 'forbidden') {
      // The checker is open to all product types with no account or key. A 403
      // here is unexpected; show whatever the API said rather than guessing.
      bodyEl().innerHTML = `<div class="err"><strong>Check not allowed.</strong>
        <p>${escapeHtml(String(msg.message ?? 'This request was rejected.'))}</p></div>`;
    } else if (msg.kind === 'empty') {
      bodyEl().innerHTML = `<p class="hint">Couldn't find scannable text here. Try selecting text instead.</p>`;
    } else {
      bodyEl().innerHTML = `<div class="err"><strong>Check failed.</strong><p>${escapeHtml(String(msg.message ?? 'Unknown error'))}</p></div>`;
    }
  }
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

$('scan').addEventListener('click', async () => {
  clearScanWatchdog();
  bodyEl().innerHTML = `<div class="loading"><div class="spin"></div><span>Starting scan…</span></div>`;
  const delivered = await sendToPage({
    type: 'cmd',
    action: 'scan',
    classes: selectedClasses,
    jurisdictions: selectedJurisdictions,
    hideSingle: hideSingleWord,
    statuses: visibleStatuses,
    mode: scanMode,
  });
  if (!delivered) {
    bodyEl().innerHTML = unreachablePageHtml();
    return;
  }
  // Delivered, but the agent still has to answer (tm-progress/results/error).
  // Arm the watchdog so a silent agent can't leave us spinning forever.
  armScanWatchdog();
});

$('clear').addEventListener('click', () => {
  lastMatches = [];
  lastStale = false;
  lastPartial = false; // clear the "Incomplete scan" banner too, not just the matches
  renderCats();
  renderResults();
  void sendToPage({ type: 'cmd', action: 'clear' });
});

$('show-single').addEventListener('change', (e) => {
  hideSingleWord = !(e.target as HTMLInputElement).checked;
  storageSet({ [HIDE_SINGLE_KEY]: hideSingleWord });
  renderCats();
  renderResults();
  void sendToPage({ ...pageConfig(), action: 'rehighlight' });
});

// ---------------------------------------------------------------------------
// Init — restore the toggle, then ask the active page for any existing results.
// ---------------------------------------------------------------------------

renderCats();
renderJurisdictions();
renderLegend();
renderStatusFilters();
wireModeTabs();
wireStatusFilters();
applyModeUI();
wireFeatureTabs();
wireSettingsGear();
initKeywordsTab();

// Show the running build's version so a stale loaded extension is obvious at a
// glance (root AGENTS.md Version Visibility Law). `version` is authoritative in
// manifest.json; we read it back rather than hardcoding.
try {
  const v = `v${chrome.runtime.getManifest().version}`;
  $('ver').textContent = v;
  $('foot').textContent = v;
} catch {
  /* manifest unavailable */
}

storageGet([HIDE_SINGLE_KEY, MODE_KEY, STATUS_VISIBILITY_KEY, JURISDICTIONS_KEY], (r) => {
  if (r && Array.isArray(r[JURISDICTIONS_KEY])) setSelectedJurisdictions(r[JURISDICTIONS_KEY] as string[], false);
  if (r && typeof r[HIDE_SINGLE_KEY] === 'boolean') {
    hideSingleWord = r[HIDE_SINGLE_KEY] as boolean;
    ($('show-single') as HTMLInputElement).checked = !hideSingleWord;
  }
  if (r && r[STATUS_VISIBILITY_KEY]) {
    visibleStatuses = normalizeStatusVisibility(r[STATUS_VISIBILITY_KEY]);
    renderStatusFilters();
    renderCats();
    renderResults();
  }
  if (r && (r[MODE_KEY] === 'any' || r[MODE_KEY] === 'amazon' || r[MODE_KEY] === 'etsy')) {
    scanMode = r[MODE_KEY] as ScanMode;
    applyModeUI();
  }
});

// On open, sync config to the page and pull back any results from a prior scan.
(async () => {
  const id = await activeTabId();
  if (id == null) return;
  try {
    const state = await chrome.tabs.sendMessage(id, {
      type: 'cmd',
      action: 'sync',
      classes: selectedClasses,
      jurisdictions: selectedJurisdictions,
      hideSingle: hideSingleWord,
      statuses: visibleStatuses,
      mode: scanMode,
    });
    if (state && Array.isArray(state.matches) && state.matches.length) {
      lastMatches = state.matches;
      lastStale = !!state.stale;
      lastPartial = !!state.partial; // restore the incomplete-scan warning across reopen
      renderCats();
      renderResults();
    }
  } catch {
    /* no content script here */
  }
})();

// Tell the background this panel is open, so its self-update waits until the
// panel closes. Reconnect if the worker restarts. An older background (before
// it listened for this port) refuses the connection: read lastError so Chrome
// logs nothing, and back off instead of retrying every second.
let panelPortRetryMs = 1000;
function holdPanelPort(): void {
  try {
    const port = chrome.runtime.connect({ name: 'iscale-panel' });
    const connectedAt = Date.now();
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      panelPortRetryMs = Date.now() - connectedAt > 5000 ? 1000 : Math.min(panelPortRetryMs * 2, 60000);
      setTimeout(holdPanelPort, panelPortRetryMs);
    });
  } catch {
    /* extension context gone (reloading) */
  }
}
holdPanelPort();

