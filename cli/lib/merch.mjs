// `iscale merch login|export|status` — download your whole Amazon Merch on Demand catalog.
//
// Merch has no "export everything" button, but its own website loads your listings from
// an internal service (FindListings, up to 499 per page). Signed in to merch.amazon.com in
// a separate Chrome window (its own profile, never your everyday browser), this reads that
// same service page by page: every status and marketplace, read-only, paced gently.
//
// Resumable by design: after every page the rows are appended to catalog.ndjson and the
// position is saved to state.json (with the file's byte length), so a crash, a closed
// laptop or Ctrl+C loses at most one page. Run `iscale merch export` again and it picks up
// where it stopped. When the last page is in, it writes merch-catalog.csv / .json and
// merch-catalog-live.csv (published titles, deduplicated) for `iscale listings import`.
//
// Not an official Amazon API: Amazon can change it at any time. Reads only your account.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { iscaleHome } from './settings-store.mjs';

export const MERCH_BASE = (process.env.ISCALE_MERCH_BASE || 'https://merch.amazon.com').replace(/\/+$/, '');
const FIND_LISTINGS = '/api/ng-amazon/coral/com.amazon.merch.search.MerchSearchService/FindListings';
const ALL_STATUSES = ['DRAFT', 'TRANSLATING', 'REVIEW', 'DECLINED', 'AMAZON_REJECTED', 'PUBLISHING', 'TIMED_OUT', 'PROPAGATED', 'PUBLISHED', 'DELETED', 'LOCKED'];
const PAGE_SIZE = 499;
const PACE_MS = 700;

export function merchProfileDir(env = process.env) {
  return path.join(iscaleHome(env), 'merch-browser');
}
export function merchExportDir(env = process.env) {
  return path.join(iscaleHome(env), 'merch-export');
}

/** The seller account id Merch embeds in its own pages ("accountId":"12345"). */
export function accountIdFromHtml(html) {
  const m = /"accountId"\s*:\s*"(\d+)"/.exec(String(html || ''));
  return m ? m[1] : null;
}

export function findListingsBody(accountId, pageToken) {
  return {
    accountId, marketplaces: null, pageSize: PAGE_SIZE, pageToken: pageToken ?? [],
    sortField: 'DateCreated', sortOrder: 'Descending', status: ALL_STATUSES, productTypes: null,
    searchableOnRetail: null, deleteReasonType: ['', 'CONTENT_POLICY_VIOLATION', 'INACTIVE_NO_SALES', 'CONTENT_CREATOR'],
    __type: 'com.amazon.merch.search#FindListingsRequest',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}
function writeState(dir, state) {
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${p}.tmp`, p);
}

export function exportStatus(dir = merchExportDir()) {
  const s = readState(dir);
  if (!s) return { started: false, dir };
  return { started: true, dir, ...s, pageToken: undefined };
}

/**
 * The resumable export loop, independent of any browser:
 *   getAccountId(): Promise<string|null>
 *   fetchPage(body): Promise<{ status: number, json?: any }>
 * Returns the final state. Throws with a "safe to re-run" message on a hard failure.
 */
export async function runExport({ dir = merchExportDir(), getAccountId, fetchPage, restart = false, paceMs = PACE_MS, retryDelayMs = 10000, onProgress = () => {}, maxPages = Infinity }) {
  fs.mkdirSync(dir, { recursive: true });
  const ndjson = path.join(dir, 'catalog.ndjson');
  let state = restart ? null : readState(dir);
  // A finished export is a snapshot; running again means "refresh", so start a new
  // one (the previous catalog files stay until the new one completes).
  const previousFinishedAt = state?.done ? state.updatedAt : null;
  if (state?.done) state = null;
  if (!state) {
    const accountId = await getAccountId();
    if (!accountId) throw new Error('Not signed in to Merch (no account id on merch.amazon.com). Run: iscale merch login');
    state = { accountId, pageToken: [], pages: 0, rows: 0, bytes: 0, hitCount: null, done: false, startedAt: new Date().toISOString(), updatedAt: null, ...(previousFinishedAt ? { previousFinishedAt } : {}) };
    fs.writeFileSync(ndjson, '');
    writeState(dir, state);
  } else {
    // Drop anything written after the last saved page (a crash between the two writes).
    const size = fs.existsSync(ndjson) ? fs.statSync(ndjson).size : 0;
    if (size > state.bytes) fs.truncateSync(ndjson, state.bytes);
    if (size < state.bytes) throw new Error(`catalog.ndjson is shorter than the saved progress (${size} < ${state.bytes} bytes). Start over: iscale merch export --restart`);
  }
  let pagesThisRun = 0;
  while (!state.done && pagesThisRun < maxPages) {
    const body = findListingsBody(state.accountId, state.pageToken);
    let res = null;
    let lastProblem = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        res = await fetchPage(body);
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Merch refused the request (HTTP ${res.status}): your sign-in expired. Run: iscale merch login, then iscale merch export (it continues at page ${state.pages + 1})`), { fatal: true });
        }
        if (res.status !== 429 && res.status < 500) break;
        lastProblem = `HTTP ${res.status}`;
      } catch (e) {
        if (e.fatal) throw e;
        lastProblem = e.message.split('\n')[0];
        res = null;
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
    if (!res || res.status >= 400 || !res.json) {
      throw new Error(`Page ${state.pages + 1} failed after retries (${lastProblem || (res && `HTTP ${res.status}`) || 'no response'}). Nothing is lost: run iscale merch export again to continue from page ${state.pages + 1}.`);
    }
    const results = Array.isArray(res.json.results) ? res.json.results : [];
    if (typeof res.json.hitCount === 'number') state.hitCount = res.json.hitCount;
    if (results.length) {
      const line = JSON.stringify(results) + '\n';
      fs.appendFileSync(ndjson, line);
      state.bytes += Buffer.byteLength(line);
    }
    const next = res.json.pageToken;
    state.pages += 1;
    state.rows += results.length;
    state.done = !results.length || !Array.isArray(next) || next.length === 0 || JSON.stringify(next) === JSON.stringify(state.pageToken);
    if (!state.done) state.pageToken = next;
    state.updatedAt = new Date().toISOString();
    writeState(dir, state);
    pagesThisRun += 1;
    onProgress(state);
    if (!state.done) await sleep(paceMs);
  }
  return state;
}

const CSV_COLUMNS = ['asin', 'marketplace', 'status', 'productType', 'title', 'brand', 'listPrice', 'currencyCode', 'designId', 'listingId', 'createdDate', 'updatedDate', 'deleteReasonType', 'lockReasonType', 'searchableOnRetail'];
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isoDate = (sec) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : '');

export function toCatalogRow(r) {
  return {
    asin: r.asin ?? '', marketplace: r.marketplace ?? '', status: r.status ?? '', productType: r.productType ?? '',
    title: r.productTitle ?? '', brand: r.brandName ?? '', listPrice: r.listPrice != null ? Number(r.listPrice).toFixed(2) : '',
    currencyCode: r.currencyCode ?? '', designId: r.designId ?? '', listingId: r.listingId ?? '',
    createdDate: isoDate(r.createdDate), updatedDate: isoDate(r.updatedDate), deleteReasonType: r.deleteReasonType ?? '',
    lockReasonType: r.lockReasonType ?? '', searchableOnRetail: r.searchableOnRetail ?? '',
  };
}

/** catalog.ndjson -> merch-catalog.csv/.json + merch-catalog-live.csv (streamed line by line). */
export async function writeCatalogFiles(dir = merchExportDir()) {
  // Streamed: a big account's catalog.ndjson can be larger than a JavaScript string allows.
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'catalog.ndjson'), 'utf8'), crlfDelay: Infinity });
  const csv = fs.openSync(path.join(dir, 'merch-catalog.csv'), 'w');
  const json = fs.openSync(path.join(dir, 'merch-catalog.json'), 'w');
  const live = new Map();
  fs.writeSync(csv, CSV_COLUMNS.join(',') + '\n');
  fs.writeSync(json, '[\n');
  const seen = new Set();
  let n = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    for (const raw of JSON.parse(line)) {
      const key = raw.listingId || `${raw.marketplace}:${raw.asin}:${raw.productType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = toCatalogRow(raw);
      fs.writeSync(csv, CSV_COLUMNS.map((c) => csvCell(row[c])).join(',') + '\n');
      fs.writeSync(json, (n ? ',\n' : '') + JSON.stringify(row));
      n += 1;
      if (row.status === 'PUBLISHED' && row.title) {
        const k = JSON.stringify([row.title.toLowerCase(), row.brand.toLowerCase()]);
        if (!live.has(k)) live.set(k, { id: `merch:content:${crypto.createHash('sha256').update(k).digest('hex')}`, title: row.title, brand: row.brand, tags: row.brand, asin: row.asin, marketplace: row.marketplace });
      }
    }
  }
  fs.writeSync(json, '\n]\n');
  fs.closeSync(csv);
  fs.closeSync(json);
  const liveCols = ['id', 'title', 'brand', 'tags', 'asin', 'marketplace'];
  fs.writeFileSync(path.join(dir, 'merch-catalog-live.csv'), [liveCols.join(','), ...[...live.values()].map((r) => liveCols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  return { listings: n, liveTitles: live.size, dir };
}

// ---------------------------------------------------------------------------
// Browser side: a dedicated Chrome profile, signed in once by the user.
// ---------------------------------------------------------------------------
async function openBrowser({ headless = false, env = process.env } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('playwright-core is missing. Run: npm ci');
  }
  const dir = merchProfileDir(env);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return await chromium.launchPersistentContext(dir, {
      channel: 'chrome', headless, viewport: null,
      args: headless ? [] : ['--window-size=1200,900'],
    });
  } catch (e) {
    if (/ProcessSingleton|already in use|profile.*in use/i.test(e.message)) throw new Error('The Merch export browser is already open. Close that Chrome window and try again.');
    if (/chrome.*not found|Executable doesn't exist|channel/i.test(e.message)) throw new Error('Google Chrome is not installed (needed for the Merch sign-in window). Install Chrome and try again.');
    throw e;
  }
}

async function accountIdVia(context) {
  const r = await context.request.get(`${MERCH_BASE}/dashboard`, { timeout: 60000 });
  return r.ok() ? accountIdFromHtml(await r.text()) : null;
}

/** Opens the sign-in window and waits (up to 15 min) until Merch shows the account. */
export async function merchLogin({ log = console.error, timeoutMs = 15 * 60 * 1000 } = {}) {
  const context = await openBrowser({ headless: false });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${MERCH_BASE}/dashboard`).catch(() => {});
    const already = await accountIdVia(context).catch(() => null);
    if (already) return { ok: true, accountId: already, alreadySignedIn: true };
    log('Sign in to Amazon Merch in the Chrome window that just opened (email, password, 2-step code). Waiting…');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(5000);
      const id = await accountIdVia(context).catch(() => null);
      if (id) return { ok: true, accountId: id, alreadySignedIn: false };
      if (!context.pages().length) throw new Error('The sign-in window was closed before signing in. Run iscale merch login again.');
    }
    throw new Error('Timed out waiting for the Merch sign-in (15 minutes). Run iscale merch login again.');
  } finally {
    await context.close().catch(() => {});
  }
}

/** Runs (or continues) the export with the saved sign-in, then writes the catalog files. */
export async function merchExport({ restart = false, headless = false, log = console.error } = {}) {
  const context = await openBrowser({ headless });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${MERCH_BASE}/dashboard`).catch(() => {});
    const t0 = Date.now();
    const state = await runExport({
      restart,
      getAccountId: () => accountIdVia(context),
      fetchPage: async (body) => {
        const r = await context.request.post(`${MERCH_BASE}${FIND_LISTINGS}`, { data: body, headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
        let json = null;
        try {
          json = await r.json();
        } catch {
          json = null;
        }
        return { status: r.status(), json };
      },
      onProgress: (s) => {
        if (s.pages === 1 || s.pages % 10 === 0 || s.done) {
          const pct = s.hitCount ? ` of ~${s.hitCount.toLocaleString()} (${Math.min(100, Math.round((s.rows / s.hitCount) * 100))}%)` : '';
          log(`page ${s.pages}: ${s.rows.toLocaleString()} listings${pct} · ${Math.round((Date.now() - t0) / 1000)}s`);
        }
      },
    });
    const files = await writeCatalogFiles();
    return { ...state, pageToken: undefined, ...files };
  } finally {
    await context.close().catch(() => {});
  }
}
