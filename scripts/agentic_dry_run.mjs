#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trademarkApiKey } from '../cli/lib/api-key.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trademarkWarnings = [
  'Trademark results are risk screening, not legal clearance.',
  'EUIPO may return official_lookup_actions unless local coverage is available.',
];
function parseArgs(argv) {
  const args = {
    input: null,
    offline: false,
    trademarkBaseUrl: null,
    apiKeyEnv: null,
    out: null,
    image: null,
    mode: null,
    noTrademark: false,
    configFile: null,
  };

  // Read the value that follows a flag, failing loudly if it's missing or is
  // actually the next flag. Without this a trailing value-less flag (e.g.
  // `--config` with the path forgotten) silently consumed `undefined` and the
  // run continued with defaults, so the user's exported settings never applied.
  const requireValue = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`Missing value for ${argv[i]}`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = requireValue(i); i += 1;
    } else if (arg === '--offline') {
      args.offline = true;
    } else if (arg === '--trademark-base-url') {
      args.trademarkBaseUrl = requireValue(i); i += 1;
    } else if (arg === '--api-key-env') {
      args.apiKeyEnv = requireValue(i); i += 1;
    } else if (arg === '--out') {
      args.out = requireValue(i); i += 1;
    } else if (arg === '--image') {
      args.image = requireValue(i); i += 1;
    } else if (arg === '--mode') {
      args.mode = requireValue(i); i += 1;
    } else if (arg === '--no-trademark') {
      args.noTrademark = true;
    } else if (arg === '--config') {
      args.configFile = requireValue(i); i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

// Read an image file and encode it as a data: URL (what the core pipeline expects
// as `imageBase64`). Mime is derived from the extension so a real design file can
// be passed straight in, instead of hand-building a base64 payload.
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function imageFileToDataUrl(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported image type "${ext || '(none)'}" — use png, jpg, jpeg, webp, or gif`);
  }
  const buf = await fs.readFile(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Build an iscale.listing.generate payload straight from flags, so the CLI is
// usable on a real design without authoring a JSON file:
//   agentic:dry-run -- --image design.png --mode agent --out agent-task.json
function synthesizeListingPayload(args) {
  return {
    action: 'iscale.listing.generate',
    mode: args.mode || 'live',
    image: { path: args.image, source: 'file' },
    // Agent mode only describes the work; it makes no Amazon request itself.
    // Keep the normal listing contract intact so the calling agent knows to run
    // the real autosuggest validation before it writes the final listing.
    validateEnabled: true,
    trademarkEnabled: !args.noTrademark,
  };
}

function printHelp() {
  console.log(`Usage:
  npm run agentic:dry-run -- --input <payload.json> [options]
  npm run agentic:dry-run -- --image <design.png> [--out result.json]

Actions:
  iscale.keyword.validate   Offline keyword validation from fixture autosuggest data
  iscale.trademark.check    Plan, or run one governed live trademark API check
  iscale.listing.screen     Enforce design-only copy, then screen every listing field
  iscale.listing.generate   Provider-agnostic agent handoff for the shared
                            listing pipeline (same rules the extension UI uses)

Options:
  --input <path>            JSON input payload. A matched POD asset sidecar is
                            screened directly so listing copy is never retyped.
  --image <path>            Generate from an image file (png/jpg/webp/gif); builds an
                            iscale.listing.generate payload — no JSON file needed
  --out <path>              Write the JSON result to a file instead of stdout
  --mode <plan|agent>       listing.generate mode (default: plan). Agent mode
                            hands creative/vision work to the calling AI agent.
  --no-trademark            Skip the trademark pass for --image generation
  --config <path>           Listing settings JSON (the extension's "Export settings"
                            file, or a raw config) — uses your UI presets/prompt rules
  --offline                 Require offline mode for keyword validation
  --trademark-base-url URL  Live iScale Listings API base (for example,
                            https://your-trademark-api.example.com)
  --api-key-env NAME        Optional environment variable containing an API key.
                            Anonymous checks work when the governed API allows them.

Examples:
  # Plan a listing offline (no provider call):
  npm run agentic:dry-run -- --image design.png --mode plan
  # Produce a provider-agnostic task for the AI agent that invoked this CLI:
  npm run agentic:dry-run -- --image design.png --mode agent --out agent-task.json
`);
}

async function loadJson(inputPath) {
  if (!inputPath) {
    throw new Error('Missing required --input <path>');
  }

  const absolutePath = path.resolve(repoRoot, inputPath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

// Load a listing config from --config: accepts either a raw ListingConfig or the
// extension's exported settings wrapper ({ type, version, config }). This is what
// makes the UI's presets/prompt rules portable to the CLI.
async function loadConfigFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse((await fs.readFile(abs, 'utf8')).replace(/^﻿/, ''));
  const config =
    parsed && typeof parsed === 'object' && parsed.config && typeof parsed.config === 'object'
      ? parsed.config
      : parsed;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('--config file must contain a settings object (raw config or an exported-settings wrapper)');
  }
  return config;
}

async function loadValidateBatch() {
  const entryPoint = path.join(repoRoot, 'listing-core-runtime/src/core/validation/validateBatch.ts');
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    logLevel: 'silent',
  });

  const code = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(moduleUrl);
}

// Bundle a core TypeScript module with esbuild and import it from a data URL.
// The `@` alias mirrors the core's path alias (listing-core-runtime/src), so
// modules that import `@/lib/ai-provider` (the whole pipeline does, transitively)
// resolve the same way they do in the extension build.
async function importCoreModule(relPath) {
  const entryPoint = path.join(repoRoot, relPath);
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    logLevel: 'silent',
    alias: { '@': path.join(repoRoot, 'listing-core-runtime/src') },
  });

  const code = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(moduleUrl);
}

let famousSingleWordPolicyPromise;
function loadFamousSingleWordPolicy() {
  famousSingleWordPolicyPromise ??= importCoreModule(
    'listing-core-runtime/src/core/listing/famousSingleWordPolicy.ts'
  );
  return famousSingleWordPolicyPromise;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
}

function normalizeAutosuggest(autosuggest) {
  if (!autosuggest || typeof autosuggest !== 'object' || Array.isArray(autosuggest)) {
    throw new Error('autosuggest must be an object keyed by query');
  }

  const normalized = new Map();
  for (const [query, suggestions] of Object.entries(autosuggest)) {
    assertArray(suggestions, `autosuggest["${query}"]`);
    normalized.set(query.toLowerCase().trim(), suggestions.map(String));
  }
  return normalized;
}

function toPublicKeywordResult(keyword) {
  return {
    word: keyword.word,
    certified: Boolean(keyword.certified),
    unverified: Boolean(keyword.unverified),
    bestPosition: keyword.bestPosition ?? null,
    bestVariant: keyword.bestVariant ?? null,
  };
}

async function runKeywordValidation(payload, args) {
  if (payload.mode !== 'offline' || !args.offline) {
    throw new Error('iscale.keyword.validate requires payload mode "offline" and the --offline flag');
  }

  assertArray(payload.candidates, 'candidates');
  assertArray(payload.productVariants, 'productVariants');

  const autosuggest = normalizeAutosuggest(payload.autosuggest);
  const fetcher = async (query) => autosuggest.get(query.toLowerCase().trim()) ?? [];
  const { validateBatch } = await loadValidateBatch();
  const validated = await validateBatch(payload.candidates, fetcher, payload.productVariants, {
    concurrency: 4,
    delayBetweenBatches: 0,
  });

  return {
    action: 'iscale.keyword.validate',
    mode: 'offline',
    status: 'done',
    validated: validated.map(toPublicKeywordResult),
    warnings: [],
  };
}

function validateTrademarkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('request must be an object');
  }
  if (typeof request.text !== 'string' || request.text.trim() === '') {
    throw new Error('request.text must be a non-empty string');
  }
  if (request.classes !== undefined) assertArray(request.classes, 'request.classes');
  if (request.jurisdictions !== undefined) assertArray(request.jurisdictions, 'request.jurisdictions');
}

// Hosts (besides localhost) the screen may send listing text to: your own API,
// from TRADEMARK_ALLOWED_HOST (comma-separated) and/or an optional, untracked-in-
// forks scripts/trusted-trademark-hosts.json (a JSON array of host names).
function trustedTrademarkHosts() {
  const hosts = new Set(
    (process.env.TRADEMARK_ALLOWED_HOST ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  );
  try {
    const file = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'trusted-trademark-hosts.json'), 'utf8'));
    for (const h of Array.isArray(file) ? file : []) if (typeof h === 'string') hosts.add(h.trim().toLowerCase());
  } catch {
    /* no local trusted-hosts file */
  }
  return hosts;
}

function normalizeTrademarkBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('--trademark-base-url must use http or https');
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1';
  if (!loopback && !trustedTrademarkHosts().has(host)) {
    throw new Error('--trademark-base-url host is not allowlisted');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function trademarkCheckUrl(value) {
  const base = normalizeTrademarkBaseUrl(value);
  return /\/api\/v1\/check$/i.test(base) ? base : `${base}/api/v1/check`;
}

function trademarkHeaders(args) {
  const headers = { 'Content-Type': 'application/json' };
  if (!args.apiKeyEnv) {
    // Private deployment: send this machine's key when one is configured.
    const key = trademarkApiKey();
    if (key) headers['X-API-Key'] = key;
    return headers;
  }
  const apiKey = process.env[args.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Environment variable ${args.apiKeyEnv} is empty or unset`);
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function callTrademarkApi(request, args) {
  if (!args.trademarkBaseUrl) {
    throw new Error('Live trademark screening requires --trademark-base-url');
  }
  const endpoint = trademarkCheckUrl(args.trademarkBaseUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: trademarkHeaders(args),
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Trademark API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || raw || response.statusText;
    throw new Error(`Trademark API HTTP ${response.status}: ${detail}`);
  }
  if (!Array.isArray(body.matches) || !Array.isArray(body.jurisdictions_checked)) {
    throw new Error('Trademark API response is missing matches or jurisdictions_checked');
  }
  const invalidMetadata = [];
  if (typeof body.truncated !== 'boolean') invalidMetadata.push('truncated');
  if (typeof body.data_stale !== 'boolean') invalidMetadata.push('data_stale');
  if (
    typeof body.data_last_synced !== 'string' ||
    body.data_last_synced.trim() === '' ||
    Number.isNaN(Date.parse(body.data_last_synced))
  ) invalidMetadata.push('data_last_synced');
  if (!Array.isArray(body.official_lookup_actions)) {
    invalidMetadata.push('official_lookup_actions');
  }
  if (
    body.jurisdictions_checked.some(
      (jurisdiction) => typeof jurisdiction !== 'string' || jurisdiction.trim() === ''
    )
  ) invalidMetadata.push('jurisdictions_checked');
  if (invalidMetadata.length) {
    throw new Error(
      `Trademark API response has missing or invalid required metadata: ${invalidMetadata.join(', ')}`
    );
  }
  return { endpoint, body };
}

function findCoverageProblems(request, response) {
  const problems = [];
  if (response.truncated === true) problems.push('response_truncated');
  if (response.data_stale === true) problems.push('data_stale');
  const checked = new Set(response.jurisdictions_checked || []);
  for (const jurisdiction of request.jurisdictions || []) {
    if (!checked.has(jurisdiction)) problems.push(`jurisdiction_not_checked:${jurisdiction}`);
  }
  if ((response.official_lookup_actions || []).length > 0) {
    problems.push('official_lookup_required');
  }
  return problems;
}

async function classifyMatches(matches, famousSingleWordBrands = []) {
  const {
    isFamousSingleWordBrand,
    normalizeFamousSingleWordBrand,
  } = await loadFamousSingleWordPolicy();
  const additionalFamous = new Set(
    famousSingleWordBrands.map(normalizeFamousSingleWordBrand)
  );
  const actionable = [];
  const informational = [];
  for (const match of matches || []) {
    const registrationStatus = String(match.registration_status || '').toLowerCase();
    if (!['registered', 'pending'].includes(registrationStatus)) continue;
    const wordmark = String(match.wordmark || match.matched_text || '').trim();
    const normalized = normalizeFamousSingleWordBrand(wordmark);
    const singleWord = normalized !== '' && !normalized.includes(' ');
    const famous = isFamousSingleWordBrand(wordmark) || additionalFamous.has(normalized);
    const decorated = {
      ...match,
      policy_reason: singleWord
        ? famous
          ? 'famous_single_word'
          : 'ordinary_single_word_informational'
        : 'multi_word_phrase',
    };
    if (singleWord && !famous) informational.push(decorated);
    else actionable.push(decorated);
  }
  return { actionable, informational };
}

async function runTrademarkCheck(payload, args) {
  validateTrademarkRequest(payload.request);
  if (!args.trademarkBaseUrl) {
    if (args.apiKeyEnv) {
      throw new Error('--api-key-env requires --trademark-base-url');
    }
    if (payload.mode !== 'plan') {
      throw new Error('iscale.trademark.check live mode requires --trademark-base-url');
    }
    return {
      action: 'iscale.trademark.check',
      mode: 'plan',
      status: 'planned',
      request: payload.request,
      live_call: false,
      warnings: trademarkWarnings,
    };
  }

  const { endpoint, body } = await callTrademarkApi(payload.request, args);
  const coverage_problems = findCoverageProblems(payload.request, body);
  const classified = await classifyMatches(body.matches, payload.famousSingleWordBrands);
  const reviewRequired = coverage_problems.length > 0 || classified.actionable.length > 0;
  return {
    action: 'iscale.trademark.check',
    mode: 'live',
    status: reviewRequired ? 'trademark_review_required' : 'done',
    request: payload.request,
    live_call: true,
    endpoint,
    response: body,
    policy: {
      ordinary_single_word: 'informational',
      famous_single_word: 'actionable',
      multi_word_phrase: 'actionable',
    },
    informational_single_word_matches: classified.informational,
    actionable_matches: classified.actionable,
    coverage_problems,
    final_result: reviewRequired ? 'trademark_review_required' : 'pass',
    warnings: trademarkWarnings,
  };
}

// The trademark screen has ONE job (Jose, 2026-09-05): check the words it is given
// against the trademark databases. It does not demand a description or keywords and
// it does not judge listing copy (product nouns, lengths) - those rules live with the
// listing writer. Whatever non-empty fields arrive are screened; an empty listing is
// the only rejection.
function validateListingScreenPayload(payload) {
  if (!payload.listing || typeof payload.listing !== 'object' || Array.isArray(payload.listing)) {
    throw new Error('listing must be an object');
  }
  if (!listingScreenUnits(payload.listing).length) {
    throw new Error(
      'listing has no text to screen: give at least one of title, brand, bullets, description, keywords'
    );
  }
}

function screenableText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Every non-empty field of the listing, in Amazon order, plus the keywords as one unit.
function listingScreenUnits(listing) {
  // Generic marketplace layout (what `iscale listing generate` and the extension
  // produce): an ordered list of { id, name, content } fields, plus keywords.
  if (Array.isArray(listing.fields)) {
    const keywordText = (Array.isArray(listing.keywords) ? listing.keywords : [])
      .map((k) => (typeof k === 'string' ? k : k?.keyword ?? '').trim())
      .filter(Boolean)
      .join('\n');
    return [
      ...listing.fields.map((f, i) => ({ field: String(f?.id || f?.name || `field${i + 1}`), text: f?.content })),
      { field: 'keywords', text: keywordText },
    ]
      .filter((unit) => screenableText(unit.text))
      .map((unit) => ({ field: unit.field, text: unit.text.trim() }));
  }
  const bullets = Array.isArray(listing.bullets)
    ? listing.bullets
    : [listing.bullet1, listing.bullet2];
  const keywords = Array.isArray(listing.keywords)
    ? listing.keywords
    : typeof listing.keywords === 'string'
      ? [listing.keywords]
      : [];
  const keywordText = keywords
    .map((keyword) => (typeof keyword === 'string' ? keyword.trim() : ''))
    .filter(Boolean)
    .join('\n');
  return [
    { field: 'title', text: listing.title },
    { field: 'brand', text: listing.brand },
    { field: 'bullet1', text: bullets[0] },
    { field: 'bullet2', text: bullets[1] },
    { field: 'description', text: listing.description },
    { field: 'keywords', text: keywordText },
  ]
    .filter((unit) => screenableText(unit.text))
    .map((unit) => ({ field: unit.field, text: unit.text.trim() }));
}

async function runListingScreen(payload, args) {
  validateListingScreenPayload(payload);
  if (!args.trademarkBaseUrl) {
    throw new Error('iscale.listing.screen requires --trademark-base-url');
  }
  const requestDefaults = {
    classes: ['025'],
    include_dead: false,
    jurisdictions: ['US', 'EUIPO'],
    ...(payload.request || {}),
  };
  const units = listingScreenUnits(payload.listing);
  const screens = [];
  const coverageProblems = [];
  const actionableMatches = [];
  const informationalMatches = [];
  let endpoint = null;

  for (const unit of units) {
    const request = { ...requestDefaults, text: unit.text };
    validateTrademarkRequest(request);
    const result = await callTrademarkApi(request, args);
    endpoint = result.endpoint;
    const unitCoverage = findCoverageProblems(request, result.body);
    const classified = await classifyMatches(
      result.body.matches,
      payload.famousSingleWordBrands
    );
    coverageProblems.push(...unitCoverage.map((problem) => `${unit.field}:${problem}`));
    actionableMatches.push(
      ...classified.actionable.map((match) => ({ field: unit.field, ...match }))
    );
    informationalMatches.push(
      ...classified.informational.map((match) => ({ field: unit.field, ...match }))
    );
    screens.push({
      field: unit.field,
      text: unit.text,
      total_matches: result.body.total_matches,
      jurisdictions_checked: result.body.jurisdictions_checked,
      data_last_synced: result.body.data_last_synced,
      data_stale: result.body.data_stale,
      truncated: result.body.truncated,
      official_lookup_actions: result.body.official_lookup_actions || [],
    });
  }

  const reviewRequired = coverageProblems.length > 0 || actionableMatches.length > 0;
  const checkedJurisdictions = Array.from(
    new Set(screens.flatMap((screen) => screen.jurisdictions_checked || []))
  );
  return {
    action: 'iscale.listing.screen',
    mode: 'live',
    status: reviewRequired ? 'trademark_review_required' : 'done',
    live_call: true,
    listing: payload.listing,
    trademark_receipt: {
      checked_at: new Date().toISOString(),
      endpoint,
      classes: requestDefaults.classes,
      include_dead: requestDefaults.include_dead,
      jurisdictions_requested: requestDefaults.jurisdictions,
      jurisdictions_checked: checkedJurisdictions,
      fields_checked: screens,
      policy: {
        ordinary_single_word: 'informational',
        famous_single_word: 'actionable',
        multi_word_phrase: 'actionable',
      },
      informational_single_word_matches: informationalMatches,
      actionable_matches: actionableMatches,
      coverage_problems: Array.from(new Set(coverageProblems)),
      review_required: reviewRequired,
      receipt_stale: screens.some((screen) => screen.data_stale === true),
      final_result: reviewRequired ? 'trademark_review_required' : 'pass',
      disclaimer: 'Risk screening only; not legal clearance.',
    },
    warnings: trademarkWarnings,
  };
}

// ---------------------------------------------------------------------------
// iscale.listing.generate — runs the SAME shared-core pipeline the extension UI
// runs. The CLI is an agent contract, not a model client: a calling AI agent owns
// image understanding and copywriting, while iScale owns field rules, validation,
// trademark screening, and monitoring. UI-only provider bridges never belong in
// this command's contract.
// ---------------------------------------------------------------------------

function computeSteps(validateEnabled, trademarkEnabled) {
  const steps = ['analyze', 'generate'];
  if (validateEnabled) steps.push('validate', 'rank');
  steps.push('listing');
  if (trademarkEnabled) steps.push('trademark');
  return steps;
}

function assertDataImage(image) {
  if (
    !image ||
    typeof image !== 'object' ||
    typeof image.data_url !== 'string' ||
    !/^data:image\//i.test(image.data_url)
  ) {
    throw new Error('image.data_url must be a data:image/... URL');
  }
}

async function runListingGenerate(payload, args) {
  const mode = args.mode ?? payload.mode ?? 'plan';
  if (mode !== 'plan' && mode !== 'agent' && mode !== 'live') {
    throw new Error(`iscale.listing.generate supports modes "plan" and "agent", not "${mode}"`);
  }
  // Accept an image file path (from --image or payload.image.path) and encode it,
  // as an alternative to an inline data: URL.
  if (args.image) payload.image = { path: args.image, source: 'file' };
  if (payload.image && typeof payload.image === 'object' && !payload.image.data_url && payload.image.path) {
    payload.image = { ...payload.image, data_url: await imageFileToDataUrl(payload.image.path) };
  }
  assertDataImage(payload.image);
  const validateEnabled = payload.validateEnabled !== false; // default true
  const trademarkEnabled = payload.trademarkEnabled !== false; // default true
  const marketplace = payload.marketplace ?? 'manual';

  const { DEFAULT_LISTING_CONFIG } = await importCoreModule('listing-core-runtime/src/core/types/index.ts');
  const fieldSource = payload.config?.fields ?? DEFAULT_LISTING_CONFIG.fields;
  const fields = fieldSource.map((f) => ({ id: f.id, name: f.name, maxChars: f.maxChars }));

  if (mode === 'plan') {
    const warnings = [
      'Plan mode does not call an AI model, Amazon, or the trademark API.',
      'The CLI is for use with a calling AI agent; it does not select or call an AI provider.',
    ];
    if (trademarkEnabled) warnings.push('Trademark results are risk screening, not legal clearance.');
    return {
      action: 'iscale.listing.generate',
      mode: 'plan',
      status: 'planned',
      live_call: false,
      plan: {
        marketplace,
        validateEnabled,
        trademarkEnabled,
        steps: computeSteps(validateEnabled, trademarkEnabled),
        fields,
      },
      warnings,
    };
  }

  if (mode === 'agent') {
    return {
      action: 'iscale.listing.generate',
      mode: 'agent',
      status: 'awaiting_agent',
      live_call: false,
      agent_required: true,
      agent_task: {
        image: { source: payload.image.source ?? 'file', path: payload.image.path ?? null },
        marketplace,
        fields,
        steps: computeSteps(validateEnabled, trademarkEnabled),
        rule: 'The calling AI agent performs vision analysis and listing copy. iScale Listings owns marketplace field limits, keyword/trademark rules, and monitoring.',
      },
      warnings: trademarkEnabled ? ['Trademark results are risk screening, not legal clearance.'] : [],
    };
  }

  if (mode === 'live') {
    throw new Error(
      'CLI live provider execution is UI-only. Invoke this CLI from an AI agent with mode "agent"; do not pass provider credentials or bridge URLs to the CLI.'
    );
  }

}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Payload from --input, or synthesized from --image for one-shot generation.
  let payload;
  if (args.input) {
    payload = await loadJson(args.input);
  } else if (args.image) {
    payload = synthesizeListingPayload(args);
  } else {
    throw new Error('Provide --input <payload.json> or --image <path> (see --help)');
  }

  // The matched PNG/JSON sidecar is the cross-module POD contract. Accept the
  // sidecar itself so the CLI screens exactly what the uploader will consume,
  // avoiding a hand-copied payload that can drift from the asset.
  if (
    !payload.action &&
    payload.record_type === 'amazon_merch_upload_asset' &&
    payload.listing &&
    typeof payload.listing === 'object'
  ) {
    const prior = payload.trademark_screening || {};
    payload = {
      action: 'iscale.listing.screen',
      mode: 'live',
      listing: payload.listing,
      request: {
        classes: prior.international_classes || ['025'],
        include_dead: prior.include_dead === true,
        jurisdictions: prior.jurisdictions || ['US', 'EUIPO'],
      },
    };
  }

  // --config overlays the operator's exported UI settings onto the payload config.
  if (args.configFile) {
    const loaded = await loadConfigFile(args.configFile);
    payload.config = { ...(payload.config ?? {}), ...loaded };
  }

  let result;
  if (payload.action === 'iscale.keyword.validate') {
    result = await runKeywordValidation(payload, args);
  } else if (payload.action === 'iscale.trademark.check') {
    result = await runTrademarkCheck(payload, args);
  } else if (payload.action === 'iscale.listing.screen') {
    result = await runListingScreen(payload, args);
  } else if (payload.action === 'iscale.listing.generate') {
    result = await runListingGenerate(payload, args);
  } else {
    throw new Error(`Unsupported action: ${payload.action ?? '<missing>'}`);
  }

  const json = JSON.stringify(result, null, 2);
  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    await fs.writeFile(outPath, `${json}\n`, 'utf8');
    console.log(`Wrote ${outPath}`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
