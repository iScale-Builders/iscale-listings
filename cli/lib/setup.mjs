// `iscale setup` — a guided, resumable setup a user (or their AI agent) can
// follow end to end: pick a database, get official US/EU data access, load the
// data, keep it fresh. It tracks where each step stands, and it writes the
// office correspondence so the user mostly just supplies their details and
// sends/approves. Everything personal stays in ~/.iscale-listings (never Git).

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { iscaleHome } from './settings-store.mjs';
import { repoRoot } from './core-loader.mjs';
import { trademarkApiKey } from './api-key.mjs';
import { loadStore } from './monitor.mjs';

const FOLLOW_UP_DAYS = 7;

export const ACCESS_STATES = ['not_started', 'account_created', 'requested', 'waiting_reply', 'approved', 'credentials_saved', 'verified'];

const PROFILE_FIELDS = {
  name: 'Your full legal name',
  email: 'Email the offices should reply to',
  country: 'Country you live in / your business is registered in',
  subscriberType: '"natural person" (just you) or "legal person" (a company)',
  business: 'Business / shop name (optional)',
  legalEntity: 'Legal company name, if a company (optional)',
  website: 'Shop or website URL (optional)',
};

function file(name, env) {
  return path.join(iscaleHome(env), name);
}

function readJson(name, env, fallback) {
  const f = file(name, env);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
}

function writeJson(name, data, env) {
  const f = file(name, env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return f;
}

export const loadProfile = (env = process.env) => readJson('profile.json', env, {});
export const loadSetup = (env = process.env) => readJson('setup.json', env, { database: null });
export const loadAccess = (env = process.env) => readJson('access.json', env, { sources: {} });

export function saveProfile(values, env = process.env) {
  const profile = { ...loadProfile(env) };
  for (const key of Object.keys(PROFILE_FIELDS)) if (typeof values[key] === 'string' && values[key].trim()) profile[key] = values[key].trim();
  return { path: writeJson('profile.json', profile, env), profile };
}

export function missingProfileFields(profile) {
  return ['name', 'email', 'country', 'subscriberType'].filter((k) => !profile[k]).map((k) => ({ field: k, ask: PROFILE_FIELDS[k] }));
}

export function setDatabase(choice, env = process.env) {
  if (!['supabase', 'local', 'postgres'].includes(choice)) throw new Error('Database: supabase, local (Supabase/Docker), or postgres (native PostgreSQL; require its clean-install proof).');
  const setup = { ...loadSetup(env), database: choice, chosenAt: new Date().toISOString() };
  writeJson('setup.json', setup, env);
  return setup;
}

export function markScheduled(env = process.env) {
  writeJson('setup.json', { ...loadSetup(env), scheduledAt: new Date().toISOString() }, env);
}

export function setWorkflow(workflow, env = process.env) {
  if (!['cli', 'extension-subscription', 'extension-api'].includes(workflow)) throw new Error('Workflow: cli, extension-subscription or extension-api');
  writeJson('setup.json', { ...loadSetup(env), workflow }, env);
  return workflow;
}

export function recordAcceptance(topic, evidenceFile, env = process.env) {
  if (!['schedule', 'extension', 'backup', 'restore'].includes(topic)) throw new Error('Proof topic: schedule, extension, backup or restore');
  const evidence = path.resolve(evidenceFile);
  const stat = fs.statSync(evidence);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Evidence must be a dossier file up to 16 MiB, not a data dump');
  const record = { file: evidence, sha256: crypto.createHash('sha256').update(fs.readFileSync(evidence)).digest('hex'), reviewedAt: new Date().toISOString(), classification: 'reported manual review; not independently verified' };
  const reviews = readJson('setup-reviews.json', env, {});
  reviews[topic] = record;
  writeJson('setup-reviews.json', reviews, env);
  return { topic, sha256: record.sha256, classification: record.classification };
}

export function recordListingScreen(result, env = process.env) {
  return writeJson('listing-screen-last.json', {
    schema: 'iscale.listing-screen/1', checkedAt: new Date().toISOString(),
    status: result.status, classes: result.classes, jurisdictions: result.jurisdictions,
    actionableCount: result.actionable?.length ?? 0, incomplete: result.incomplete === true,
  }, env);
}

/** Record progress on an office request; waiting states get a follow-up date. */
export function recordAccess(source, state, note, env = process.env, now = new Date()) {
  if (!['uspto', 'euipo'].includes(source)) throw new Error('Source must be uspto or euipo.');
  if (!ACCESS_STATES.includes(state)) throw new Error(`State must be one of: ${ACCESS_STATES.join(', ')}`);
  const access = loadAccess(env);
  const prev = access.sources[source] ?? { notes: [] };
  const waiting = state === 'requested' || state === 'waiting_reply';
  access.sources[source] = {
    state,
    updatedAt: now.toISOString(),
    followUpDue: waiting ? new Date(now.getTime() + FOLLOW_UP_DAYS * 864e5).toISOString().slice(0, 10) : null,
    notes: [...(prev.notes ?? []), ...(note ? [{ at: now.toISOString(), note }] : [])],
  };
  writeJson('access.json', access, env);
  return access.sources[source];
}

/** Names (never values) of the settings each step needs, read from .env.local. */
export function envStatus(root = repoRoot, env = process.env) {
  const f = path.join(root, '.env.local');
  const set = new Set();
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[2].trim() && !/^<.*>$/.test(m[2].trim())) set.add(m[1]);
    }
  }
  const need = (...names) => names.filter((n) => !set.has(n) && !env[n]);
  return {
    exists: fs.existsSync(f),
    database: set.has('DATABASE_URL') || env.DATABASE_URL ? need('TM_DB_URL') : need('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TM_DB_URL'),
    uspto: need('USPTO_API_KEY'),
    euipo: need('EUIPO_CLIENT_ID', 'EUIPO_CLIENT_SECRET'),
  };
}

export async function apiHealth(apiBase, env = process.env) {
  try {
    const key = trademarkApiKey(env);
    const resp = await fetch(`${apiBase.replace(/\/+$/, '')}/api/v1/health`, { headers: key ? { 'X-API-Key': key } : {}, signal: AbortSignal.timeout(5000) });
    const body = await resp.json().catch(() => ({}));
    return { reachable: true, status: resp.status, body, valid: resp.status === 200 && body?.status === 'ok' && body?.version === 'v1' && body?.database === 'connected' && typeof body?.data_stale === 'boolean' && Array.isArray(body?.jurisdictions) };
  } catch (e) {
    return { reachable: false, valid: false, error: 'API probe failed or timed out; check your private API configuration' };
  }
}

function jurisdictionReady(health, code) {
  const j = health.body?.jurisdictions?.find?.((x) => x.jurisdiction === code);
  // Allow at most five minutes of clock skew; future-dated data is not fresh proof.
  return j ? { marks: j.live_mark_count, fresh: j.status === 'completed' && j.local_database === true && j.data_stale === false && Number.isFinite(Number(j.live_mark_count)) && Number(j.live_mark_count) > 0 && Number.isFinite(Date.parse(j.last_synced_at)) && Date.parse(j.last_synced_at) <= Date.now() + 5 * 60000, lastSync: j.last_synced_at } : null;
}

export async function setupHealth({ apiBase = '', env = process.env } = {}) {
  const health = await apiHealth(apiBase, env);
  const registries = ['US', 'EUIPO'].map((code) => ({ jurisdiction: code, ready: health.valid === true && jurisdictionReady(health, code)?.fresh === true }));
  return { schema: 'iscale.setup-health/1', checkedAt: new Date().toISOString(), apiReady: health.valid === true, httpStatus: health.status ?? null, registries, ready: health.valid === true && registries.every((j) => j.ready) };
}

/** The whole checklist, in order, with the single next action. */
export async function setupStatus({ apiBase = '', env = process.env, root = repoRoot } = {}) {
  const profile = loadProfile(env);
  const setup = loadSetup(env);
  const workflow = setup.workflow || 'cli';
  const access = loadAccess(env).sources;
  const envs = envStatus(root, env);
  const health = await apiHealth(apiBase, env);
  const us = health.valid ? jurisdictionReady(health, 'US') : null;
  const eu = health.valid ? jurisdictionReady(health, 'EUIPO') : null;
  /** @type {Array<{id:string, done:boolean, todo:string, required?:boolean, applicable?:boolean, state?:any, detail?:any, evidence?:string, followUpDue?:any}>} */
  const steps = [
    { id: 'profile', done: missingProfileFields(profile).length === 0, todo: 'iscale setup profile --name "…" --email "…" --country "…" --subscriber-type "natural person"' },
    { id: 'database', done: !!setup.database, todo: 'iscale setup database supabase   (or: local)' },
    { id: 'env', done: envs.exists && envs.database.length === 0, todo: `iscale setup guide database   (missing: ${envs.database.join(', ') || '.env.local'})` },
    { id: 'api', done: health.valid === true, todo: health.status === 401
      ? 'iscale setup guide api-auth (register/check your own key)'
      : health.status === 503 && health.body?.error?.code === 'SYNC_STALE'
        ? 'iscale setup guide uspto-import (first import or refresh stale US data, then recheck)'
        : health.status === 404
          ? 'iscale setup guide api-auth (correct your API base URL and /api/v1/health route)'
          : 'npm run build && npm start   (then re-run iscale setup)' },
    { id: 'uspto-access', done: envs.uspto.length === 0, todo: 'iscale setup guide uspto', state: access.uspto?.state ?? 'not_started' },
    { id: 'uspto-data', done: !!us?.marks && us.fresh, todo: 'iscale setup guide uspto-import', detail: us },
    { id: 'euipo-access', done: envs.euipo.length === 0, todo: 'iscale setup guide euipo   (drafts: iscale setup letters euipo)', state: access.euipo?.state ?? 'not_started', followUpDue: access.euipo?.followUpDue ?? null },
    { id: 'euipo-data', done: !!eu?.marks && eu.fresh, todo: 'iscale setup guide euipo-import', detail: eu },
    { id: 'schedule', done: false, state: setup.scheduledAt ? 'reported configuration; execution not verified' : 'not configured', todo: `iscale setup guide schedule   (${setup.database === 'local' ? 'Task Scheduler / cron' : 'GitHub Actions'})` },
  ];
  const port = Number(env.ISCALE_HELPER_PORT || 18799);
  // API-key AI needs no subscription, but a fresh private extension install
  // still uses this helper to deliver its machine-local trademark key safely.
  const helper = workflow !== 'cli' ? await fetch(`http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 18799}/health`, { signal: AbortSignal.timeout(1500) })
    .then(async (response) => ({ status: response.status, body: await response.json() })).catch(() => null)
    : null;
  const receipt = readJson('listing-screen-last.json', env, {});
  const age = Date.now() - Date.parse(receipt.checkedAt);
  const store = loadStore(env);
  steps.push(
    { id: 'helper', done: helper?.status === 200 && helper?.body?.ok === true && helper?.body?.backend === 'iscale-helper', todo: 'iscale setup guide extension', evidence: 'live loopback helper response; does not prove extension login' },
    { id: 'extension', done: false, todo: 'iscale setup guide acceptance (verify loaded version, registry selection, and a real check)', evidence: 'requires a real browser check; never inferred from files on disk' },
    { id: 'listing', done: receipt.schema === 'iscale.listing-screen/1' && receipt.incomplete !== true && age >= 0 && age <= 30 * 3600000 && ['clear', 'risk'].includes(receipt.status), todo: 'iscale setup guide listings', evidence: 'recent complete CLI-generated screening receipt; risk still needs review' },
    { id: 'shop', done: store.listings.length > 0 && store.listings.every((l) => ['clear', 'risk'].includes(l.lastScan?.status) && l.lastScan?.incomplete === false && l.lastScan?.includeDescription === true && (!l.brand || l.lastScan?.brandIncluded === true)) && Date.now() - Date.parse(store.lastScanAt) >= 0 && Date.now() - Date.parse(store.lastScanAt) <= 30 * 3600000, todo: 'iscale setup guide listings (import and scan with --include-description)', evidence: 'recent complete local store screening; not a scheduler trigger proof' },
    { id: 'backup', done: false, todo: 'iscale setup guide backups', evidence: 'a copy/TOC listing is not restore proof' },
    { id: 'restore', done: false, todo: 'iscale setup guide backups (restore onto an isolated scratch database)', evidence: 'requires a restore drill, not self-attestation' },
  );
  const manualTopics = ['schedule', 'extension', 'backup', 'restore'];
  const reviews = readJson('setup-reviews.json', env, {});
  const unchangedReview = (review) => {
    try { return !!review && fs.statSync(review.file).size <= 16 * 1024 * 1024 && crypto.createHash('sha256').update(fs.readFileSync(review.file)).digest('hex') === review.sha256; } catch { return false; }
  };
  for (const step of steps) {
    step.required = !manualTopics.includes(step.id);
    step.applicable = (step.id !== 'helper' || workflow !== 'cli') && (step.id !== 'extension' || workflow !== 'cli');
    // An API-key AI user can stop the key bridge after recording the actual
    // browser/key-delivery review. This is optionality, not a verified helper claim.
    if (step.id === 'helper' && workflow === 'extension-api' && unchangedReview(reviews.extension)) {
      step.required = false;
      step.evidence = 'optional after reported manual browser/key-delivery review; no subscription required';
    }
  }
  const acceptance = steps.filter((step) => manualTopics.includes(step.id) && step.applicable).map((step) => {
    const review = reviews[step.id];
    const unchanged = unchangedReview(review);
    return { id: step.id, reviewRecorded: unchanged, classification: unchanged ? 'reported manual review; not independently verified' : 'pending external proof/review', todo: `iscale setup guide acceptance; then iscale setup review ${step.id} <private-evidence-file>` };
  });
  const next = steps.find((s) => s.required && s.applicable && !s.done) ?? null;
  const overdue = Object.entries(access)
    .filter(([, s]) => s.followUpDue && s.followUpDue <= new Date().toISOString().slice(0, 10))
    .map(([source, s]) => ({ source, followUpDue: s.followUpDue, todo: `iscale setup letters ${source} --followup` }));
  return { database: setup.database, workflow, apiBase, steps, next, acceptance, nextAcceptance: acceptance.find((item) => !item.reviewRecorded) ?? null, overdueFollowUps: overdue };
}

// ---------------------------------------------------------------------------
// Correspondence. Office addresses and requirements are the ones recorded from
// the offices' own pages; the agent must still re-check the linked official page
// before sending, because offices change their process.
// ---------------------------------------------------------------------------

export function letters(source, profile, { followup = false } = {}) {
  const who = profile.name || '[your name]';
  const company = profile.subscriberType === 'legal person';
  if (source === 'euipo') {
    if (followup) {
      return [
        {
          id: 'euipo-followup',
          to: 'docs.apiplatform@euipo.europa.eu',
          subject: 'Follow-up: Production API subscription request (Trademark search)',
          body: `Hello,\n\nI am following up on my Production subscription request for the EUIPO API Portal product "Trademark search", sent on [date of first email]. Could you let me know whether anything else is needed from me to complete the review?\n\nApp name: [the app name you registered in the API Portal]\nAccount email: ${profile.email || '[your email]'}\n\nThank you,\n${who}`,
          attachments: [],
        },
      ];
    }
    return [
      {
        id: 'euipo-production-docs',
        verify: 'https://dev.euipo.europa.eu/getting-started',
        before: [
          'Create/sign in to an EUIPO user account (https://euipo.europa.eu → Login/Register).',
          'In the API Portal (https://dev.euipo.europa.eu), open "Apps", register an app, and subscribe it to the "Trademark search" product.',
          'Production access needs identity documents sent by email (below). Sandbox works without them but is not real data.',
        ],
        to: 'docs.apiplatform@euipo.europa.eu',
        subject: 'Documentation for Production API subscription request — Trademark search',
        body:
          `Hello,\n\nPlease find attached the documentation for my Production API subscription request.\n\n` +
          `Requested API: Trademark search\nEnvironment: Production\nApp name: [the app name you registered in the API Portal]\n` +
          `Purpose: screening my own product listings for trademark conflicts, using a private local copy of EU trade mark data that I keep up to date.\n\n` +
          `Subscriber type: ${company ? 'legal person' : 'natural person'}\nActing person: ${who}\n` +
          (company ? `Entity: ${profile.legalEntity || profile.business || '[legal company name]'}\n` : '') +
          `Country: ${profile.country || '[country]'}\n\nPlease let me know if anything else is required.\n\nRegards,\n${who}\n${profile.email || ''}`,
        attachments: company
          ? ['Passport or national ID of the acting person', 'Company-register extract showing the company address and that you can act for it', 'If the register does not show your authority: a short signed authorization letter from the company']
          : ['Passport or national ID card', 'Proof of address (e.g. utility bill) if your ID does not show your address'],
        after: 'When approved, copy the Client ID and Client Secret from the portal into .env.local as EUIPO_CLIENT_ID / EUIPO_CLIENT_SECRET (never into chat), then run: iscale setup access euipo credentials_saved',
      },
    ];
  }
  if (source === 'uspto') {
    return [
      {
        id: 'uspto-odp-key',
        verify: 'https://data.uspto.gov',
        before: [
          'Sign in to (or create) a USPTO.gov account at https://data.uspto.gov — USPTO requires an account for Open Data Portal access, and account creation may include identity verification that only you can complete.',
          'In the Open Data Portal, open your profile / API key page and create an API key.',
          'No email is normally needed. If the portal blocks you, use the support contact listed on https://data.uspto.gov and the draft below.',
        ],
        to: '[USPTO Open Data Portal support contact — copy it from https://data.uspto.gov]',
        subject: 'Open Data Portal API key access — trademark bulk data (TRTYRAP / TRTDXFAP)',
        body:
          `Hello,\n\nI am trying to obtain an Open Data Portal API key to download the trademark bulk data products TRTYRAP (annual) and TRTDXFAP (daily applications) for screening my own product listings against registered marks.\n\n` +
          `[Describe what happens: e.g. the API key page shows an error / my account verification is pending.]\n\nAccount email: ${profile.email || '[your email]'}\n\nThank you,\n${who}`,
        attachments: [],
        after: 'Put the key in .env.local as USPTO_API_KEY (never into chat), then run: iscale setup access uspto credentials_saved',
      },
    ];
  }
  throw new Error('Letters are available for: uspto, euipo');
}

export function writeLetters(items, dir) {
  fs.mkdirSync(dir, { recursive: true });
  return items.map((l) => {
    const f = path.join(dir, `${l.id}.txt`);
    const text = [
      ...(l.verify ? [`Check first (offices change their process): ${l.verify}`, ''] : []),
      ...(l.before?.length ? ['BEFORE SENDING:', ...l.before.map((b) => `- ${b}`), ''] : []),
      `To: ${l.to}`,
      `Subject: ${l.subject}`,
      '',
      l.body,
      '',
      ...(l.attachments.length ? ['Attach:', ...l.attachments.map((a) => `- ${a}`), ''] : []),
      ...(l.after ? [`AFTER: ${l.after}`] : []),
    ].join('\n');
    fs.writeFileSync(f, text);
    return f;
  });
}
