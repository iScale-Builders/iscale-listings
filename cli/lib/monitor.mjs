// Store monitoring: import a shop's listings once, then re-screen all of them
// whenever the trademark data updates, and raise an alert for every NEW risk.
// A newly registered mark that matches an old listing shows up on the next scan.
//
// Everything lives in one local JSON file (~/.iscale-listings/listings.json),
// so monitoring needs no extra database.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './json-file.mjs';
import { iscaleHome } from './settings-store.mjs';
import { checkText } from './trademark.mjs';

export function storePath(env = process.env) {
  return path.join(iscaleHome(env), 'listings.json');
}

export function loadStore(env = process.env) {
  const file = storePath(env);
  if (!fs.existsSync(file)) return { listings: [], alerts: [], lastScanAt: null };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { listings: data.listings ?? [], alerts: data.alerts ?? [], lastScanAt: data.lastScanAt ?? null };
}

export function saveStore(store, env = process.env) {
  const file = storePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

/** RFC 4180 CSV: quoted fields, doubled quotes, and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const COLUMN_ALIASES = {
  title: ['title', 'listing title', 'name', 'product title', 'item name'],
  brand: ['brand', 'brand name', 'brand_name'],
  tags: ['tags', 'keywords', 'search terms'],
  description: ['description', 'body', 'bullets'],
  id: ['listing_id', 'listing id', 'sku', 'id', 'asin', 'url'],
};

function pick(record, key) {
  for (const alias of COLUMN_ALIASES[key]) {
    const hit = Object.keys(record).find((k) => k.trim().toLowerCase() === alias);
    if (hit && String(record[hit]).trim()) return String(record[hit]).trim();
  }
  return '';
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map(String).map((t) => t.trim()).filter(Boolean);
  return String(value || '').split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
}

/** Records from an Etsy "Download Data" CSV, any title/tags CSV, or a JSON array. */
export function recordsFromFile(file) {
  if (/\.json$/i.test(file)) {
    const data = readJsonFile(file, 'listings file');
    return Array.isArray(data) ? data : data.listings ?? [];
  }
  if (!fs.existsSync(file)) throw new Error(`Can't find listings file: ${path.resolve(file)}`);
  const raw = fs.readFileSync(file, 'utf8');
  const [header, ...rows] = parseCsv(raw);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function normalizeRecord(record, source) {
  const title = pick(record, 'title');
  if (!title) return null;
  const tagsRaw = Array.isArray(record.tags) ? record.tags : pick(record, 'tags');
  const brand = pick(record, 'brand');
  const tags = splitTags(tagsRaw);
  const description = pick(record, 'description');
  const id = pick(record, 'id') || `${source}:content:${crypto.createHash('sha256').update(JSON.stringify([title, brand, tags, description])).digest('hex')}`;
  return { id, title, brand, tags, description, source };
}

/** Add or update listings (matched by id). Returns counts. */
export function importListings(store, records, { source = 'import', classes } = {}) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const rec of records) {
    const item = normalizeRecord(rec, source);
    if (!item) {
      skipped++;
      continue;
    }
    const existing = store.listings.find((l) => l.id === item.id);
    if (existing) {
      const changed = ['title', 'brand', 'description'].some((key) => (existing[key] || '') !== (item[key] || ''))
        || JSON.stringify(existing.tags || []) !== JSON.stringify(item.tags)
        || (classes && JSON.stringify(existing.classes || []) !== JSON.stringify(classes));
      Object.assign(existing, item, classes ? { classes } : {});
      if (changed) existing.lastScan = null; // New content/scope needs a new check; known alerts remain.
      updated++;
    } else {
      store.listings.push({ ...item, ...(classes ? { classes } : {}), addedAt: new Date().toISOString(), lastScan: null });
      added++;
    }
  }
  return { added, updated, skipped, total: store.listings.length };
}

export function listingText(listing, { includeDescription = false } = {}) {
  return [listing.title, ...(includeDescription && listing.description ? [listing.description] : [])].join('\n');
}

const RATE_LIMITED = /RATE_LIMITED|Too many requests|429/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-screen every listing. New actionable matches (not alerted before for that
 * listing) become alerts. Returns a summary; the store is mutated in place.
 *
 * Paced (`perMinute` listings a minute, default 240 ≈ 480 API calls) so a whole
 * catalog never floods the trademark API that the extension and uploaders share;
 * a listing that came back rate-limited is retried after a pause instead of being
 * recorded as UNVERIFIED.
 */
export async function scanListings(store, { classes, apiBase, allowSingleWord = true, includeDescription = false, check = checkText, onProgress, perMinute = 240, rateLimitPauseMs = 60000, wait = sleep } = {}) {
  const now = new Date().toISOString();
  const summary = { scanned: 0, clear: 0, risk: 0, unverified: 0, incomplete: 0, coverageComplete: true, coverageGaps: /** @type {Array<{listingId:string, reason:string}>} */ ([]), newAlerts: [] };
  const gapMs = perMinute > 0 ? 60000 / perMinute : 0;
  let last = 0;
  for (const listing of store.listings) {
    const run = async () => {
      const since = Date.now() - last;
      if (last && since < gapMs) await wait(gapMs - since);
      last = Date.now();
      return check({
        text: listing.title,
        fields: [
          { id: 'title', name: 'Title', content: listing.title },
          ...(listing.brand ? [{ id: 'brand', name: 'Brand', content: listing.brand }] : []),
          ...(includeDescription && listing.description ? [{ id: 'description', name: 'Description', content: listing.description }] : []),
        ],
        terms: listing.tags ?? [],
        classes: listing.classes ?? classes,
        apiBase,
        allowSingleWord,
      });
    };
    let r = await run();
    for (let attempt = 1; attempt <= 3 && r.status === 'unverified' && RATE_LIMITED.test(r.reason ?? ''); attempt += 1) {
      await wait(rateLimitPauseMs * attempt);
      r = await run();
    }
    summary.scanned++;
    const incomplete = r.status === 'unverified' || r.incomplete === true;
    const status = incomplete && r.status === 'clear' ? 'unverified' : r.status;
    summary[status]++;
    if (incomplete) {
      summary.incomplete++;
      summary.coverageGaps.push({ listingId: listing.id, reason: r.reason || 'Coverage incomplete' });
    }
    listing.lastScan = { at: now, status, incomplete, includeDescription, brandIncluded: !!listing.brand, reason: r.reason ?? null, matches: r.actionable.map((m) => m.wordmark) };
    for (const m of r.actionable) {
      const key = `${m.jurisdiction ?? 'US'}:${m.serial_number}`;
      if (store.alerts.some((a) => a.listingId === listing.id && a.key === key)) continue;
      const alert = {
        listingId: listing.id,
        title: listing.title,
        key,
        wordmark: m.wordmark,
        jurisdiction: m.jurisdiction ?? 'US',
        serial: m.serial_number,
        class: m.international_class,
        status: m.registration_status ?? m.status,
        owner: m.owner ?? null,
        filingDate: m.filing_date ?? null,
        firstSeenAt: now,
        acknowledged: false,
      };
      store.alerts.push(alert);
      summary.newAlerts.push(alert);
    }
    onProgress?.(summary.scanned, store.listings.length, listing, r.status);
  }
  store.lastScanAt = now;
  summary.coverageComplete = summary.incomplete === 0;
  return summary;
}

export function scanCompletionExitCode(summary) {
  if (summary.unverified > 0 || summary.incomplete > 0) return 3;
  return summary.newAlerts.length ? 2 : 0;
}
