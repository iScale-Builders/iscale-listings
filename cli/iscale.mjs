#!/usr/bin/env node
// iscale — one command for iScale Listings: trademark checks, listing
// generation on your own AI subscription, the local helper that shares settings
// with the Chrome extension, and (soon) store monitoring and guided setup.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCore, repoRoot } from './lib/core-loader.mjs';
import { engineNames, runEngine, ENGINES } from './lib/engines.mjs';
import { autostartInstalled, installAutostart, uninstallAutostart } from './lib/autostart.mjs';
import { readJsonFile } from './lib/json-file.mjs';
import { startHelper, trustExtension, trustedExtensionIds } from './lib/helper-server.mjs';
import { readSettings, settingsPath, writeSettings } from './lib/settings-store.mjs';
import { checkText, formatCheck, EXIT_CODES } from './lib/trademark.mjs';
import { agentTask, generateListing, saveListing } from './lib/listing.mjs';
import { importListings, loadStore, recordsFromFile, saveStore, scanListings, scanCompletionExitCode } from './lib/monitor.mjs';
import {
  letters,
  loadProfile,
  loadSetup,
  markScheduled,
  missingProfileFields,
  recordAccess,
  recordListingScreen,
  recordAcceptance,
  setWorkflow,
  saveProfile,
  setDatabase,
  setupStatus,
  setupHealth,
  writeLetters,
} from './lib/setup.mjs';
import { iscaleHome } from './lib/settings-store.mjs';
import { trademarkApiKey } from './lib/api-key.mjs';
import { exportStatus, merchExport, merchLogin } from './lib/merch.mjs';

const HELP = `iscale — iScale Listings command line

Trademark
  iscale check "<text>" [--term tag ...] [--class 025 ...] [--json]
      Screen any text and/or single keywords (US + EU).
      Exit code: 0 clear, 2 risk, 3 unverified (NOT clear), 1 error.

Store monitoring (re-check your whole shop whenever trademark data updates)
  iscale listings import <etsy-export.csv|file.json> [--class 025 ...]
  iscale listings add "<title>" [--tag t ...]
  iscale listings list | remove <id>
  iscale listings scan [--include-description] [--per-minute 240]   Exit 2 = new alerts, 3 = unverified
  iscale alerts [--all] [--ack <key|listing-id|all>]

Amazon Merch catalog (your whole account, every status and marketplace)
  iscale merch login                Opens a separate Chrome window; sign in to Merch once.
  iscale merch export [--restart]   Downloads every listing. Safe to stop: run it again to continue.
                                    After it finishes, running it again refreshes the catalog.
  iscale merch status               Progress of the current export.
      Files: ~/.iscale-listings/merch-export/merch-catalog.csv, .json, merch-catalog-live.csv
      Then:  iscale listings import ~/.iscale-listings/merch-export/merch-catalog-live.csv

Listings (uses the same settings as the Chrome extension)
  iscale listing generate <image> --agent [--json]   DEFAULT. The AI agent running this CLI (Claude, Codex,
                                                     Grok, any agent) writes the listing itself: this prints the
                                                     user's rules, fields + limits, banned words and classes.
                                                     The agent writes the fields, then runs
                                                     'iscale listing screen <file.json>' / 'iscale check'.
                                                     No ChatGPT plan, Codex or OpenAI key is needed for the CLI.
  iscale listing generate <image> --engine codex [--model M]   OPT-IN only: run the extension's pipeline
                                  inside the CLI on your own ChatGPT plan (Codex SDK).
                                  [--no-trademark] [--no-validate] [--out file.json]
      The image's JSON sidecar (same name: design.png -> design.json) that describes the design is used
      instead of re-reading the image; otherwise the image is read. --read-image forces it.
      The whole listing + keywords (= tags, best first) is saved into that JSON under
      "iscale_listings". No sidecar: nothing is created. --no-save skips it.
  iscale listing screen <listing-or-sidecar.json> [--out file.json]

Guided setup (your own database + official US/EU data access)
  iscale setup                      Checklist with the single next step.
  iscale setup profile --name … --email … --country … --subscriber-type "natural person"
  iscale setup database supabase|local|postgres
  iscale setup guide prerequisites|local-walkthrough|database|uspto|uspto-import|euipo|euipo-import|schedule|extension|merch-catalog
  iscale setup letters uspto|euipo [--followup]   Ready-to-send office emails.
  iscale setup access uspto|euipo <state> [--note …]
      states: ${'not_started, account_created, requested, waiting_reply, approved, credentials_saved, verified'}
  iscale setup scheduled
  iscale setup workflow cli|extension-subscription|extension-api
  iscale setup health --json        Authenticated private API + US/EU freshness gate.
  iscale setup review <topic> <private-evidence-file>   Record a manual review, not independent verification.

Banned words (never used in any listing — shared with the extension)
  iscale ban "<word or phrase>"     Ban it; if it's a trademark, the mark is recorded with it.
  iscale unban "<word or phrase>"
  iscale banned [--json]            The list, banned trademarks first.

Local helper (shares settings with the extension, runs AI on your subscription)
  iscale helper                     Start it now (keep it running while you use the extension).
  iscale helper --install           Start it hidden at every login (no terminal to keep open).
  iscale helper --uninstall         Stop starting it at login.
  iscale helper --status            Is it running? Does it start at login? Which extension is trusted?
  iscale helper --trust <id>        Trust a (re)installed extension (id from chrome://extensions).
  iscale ai test [--engine E] [--model M]
  iscale settings [show|path|export <file>|import <file>]

Common options
  --api URL     Your trademark API (default: settings → ISCALE_TRADEMARK_API → http://localhost:3000)
  --json        Machine-readable output

Results are risk screening, not legal advice.`;

const OPTIONS = {
  class: { type: 'string', multiple: true },
  api: { type: 'string' },
  json: { type: 'boolean' },
  engine: { type: 'string' },
  model: { type: 'string' },
  agent: { type: 'boolean' },
  'no-trademark': { type: 'boolean' },
  'no-validate': { type: 'boolean' },
  'strict-single-word': { type: 'boolean' },
  out: { type: 'string' },
  tag: { type: 'string', multiple: true },
  term: { type: 'string', multiple: true },
  'include-description': { type: 'boolean' },
  all: { type: 'boolean' },
  ack: { type: 'string' },
  note: { type: 'string' },
  followup: { type: 'boolean' },
  name: { type: 'string' },
  email: { type: 'string' },
  country: { type: 'string' },
  'subscriber-type': { type: 'string' },
  business: { type: 'string' },
  'legal-entity': { type: 'string' },
  website: { type: 'string' },
  install: { type: 'boolean' },
  trust: { type: 'string' },
  uninstall: { type: 'boolean' },
  status: { type: 'boolean' },
  restart: { type: 'boolean' },
  headless: { type: 'boolean' },
  'read-image': { type: 'boolean' },
  'no-save': { type: 'boolean' },
  'per-minute': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function safeSettings() {
  try {
    return readSettings();
  } catch (e) {
    console.error(`warning: ignoring unreadable settings at ${settingsPath()}: ${e.message}`);
    return null;
  }
}

function apiBase(values, settings) {
  return values.api || process.env.ISCALE_TRADEMARK_API || process.env.TRADEMARK_API_BASE || settings?.prefs?.tmApiBase || 'http://localhost:3000';
}

function pickEngine(values, settings) {
  // An engine saved in old shared settings that no longer exists (e.g. 'claude')
  // is ignored; only an explicit --engine is an error.
  const saved = settings?.prefs?.localEngine;
  const engine = values.engine || (saved && ENGINES[saved] ? saved : 'codex');
  if (!ENGINES[engine]) throw new Error(`Unknown engine "${engine}". Use one of: ${engineNames().join(', ')}`);
  return { engine, model: values.model ?? (settings?.prefs?.localModel || undefined) };
}

/** After `listing generate`: how to ban each trademark that was taken out. */
function banHints(r) {
  const seen = new Set();
  const terms = [...(r.trademark.flaggedMarks ?? []).map((m) => m.term), ...r.trademarkedKeywords.map((t) => t.keyword)]
    .map((t) => String(t).toLowerCase())
    .filter((t) => t && !seen.has(t) && seen.add(t));
  return terms.length ? [`Never use them again: ${terms.map((t) => `iscale ban "${t}"`).join('  ·  ')}`] : [];
}

function output(values, data, human) {
  const json = JSON.stringify(data, null, 2);
  if (values.out) {
    fs.writeFileSync(path.resolve(values.out), `${json}\n`);
    console.error(`Wrote ${path.resolve(values.out)}`);
  }
  if (values.json || !human) console.log(json);
  else console.log(human);
}

async function main(argv) {
  // Private trademark API: every call (and every child script) carries the key.
  if (!process.env.TRADEMARK_API_KEY) {
    const key = trademarkApiKey();
    if (key) process.env.TRADEMARK_API_KEY = key;
  }
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd || cmd === 'help') return console.log(HELP);
  const settings = safeSettings();

  if (cmd === 'helper') {
    if (values.install) return console.log(installAutostart());
    if (values.uninstall) return console.log(uninstallAutostart());
    if (values.trust) return console.log(`Trusted extensions: ${trustExtension(values.trust).join(', ')}`);
    if (values.status) {
      const port = Number(process.env.ISCALE_HELPER_PORT || 18799);
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .catch(() => null);
      console.log(`Running now:          ${health?.ok ? `yes (v${health.version})` : 'no'}`);
      console.log(`Starts at login:      ${autostartInstalled() ? 'yes' : 'no  (iscale helper --install)'}`);
      const ids = trustedExtensionIds();
      console.log(`Trusted extension:    ${ids.length ? ids.join(', ') : 'none yet (the first iScale Listings extension that connects)'}`);
      return;
    }
    try {
      await startHelper({ version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'manifest.json'), 'utf8')).version });
    } catch (e) {
      // Already running (e.g. the login task started it): nothing to do.
      if (e?.code === 'EADDRINUSE') return console.log('The iScale helper is already running.');
      throw e;
    }
    return new Promise(() => {}); // keep running
  }

  if (cmd === 'check') {
    const text = [sub, ...rest].filter(Boolean).join(' ').trim();
    if (!text && !values.term?.length) throw new Error('Usage: iscale check "<text>" [--term tag ...] [--class 025]');
    const r = await checkText({
      text,
      terms: values.term ?? [],
      classes: values.class ?? settings?.config?.trademarkClasses,
      apiBase: apiBase(values, settings),
      allowSingleWord: values['strict-single-word'] ? false : settings?.config?.allowSingleWordTrademarks ?? true,
    });
    output(values, r, formatCheck(r));
    process.exitCode = EXIT_CODES[r.status];
    return;
  }

  if (cmd === 'listing' && sub === 'generate') {
    const imagePath = rest[0];
    if (!imagePath) throw new Error('Usage: iscale listing generate <image>');
    if (!settings) console.error(`note: no shared settings yet (${settingsPath()}); using defaults. Open the extension with \`iscale helper\` running to share yours.`);
    // The CLI is run by whichever AI agent is operating it: by default that agent
    // writes the listing (--agent). ChatGPT/Codex (gpt-5.5 etc.) is the Chrome
    // extension's helper engine and is only used here with an explicit --engine.
    if (values.agent || !values.engine) return output(values, await agentTask({ imagePath, settings }));
    const { engine, model } = pickEngine(values, settings);
    const r = await generateListing({
      imagePath,
      settings,
      engine,
      model,
      trademark: !values['no-trademark'],
      validate: !values['no-validate'],
      readImage: !!values['read-image'],
      apiBase: apiBase(values, settings),
      onPhase: (() => {
        let last = '';
        return (phase) => phase !== last && console.error(`… ${(last = phase)}`);
      })(),
    });
    if (!values['no-save']) {
      try {
        r.savedTo = saveListing(imagePath, r);
        console.error(r.savedTo ? `Saved the listing, keywords and tags into ${r.savedTo.file} under "iscale_listings"` : 'No JSON sidecar next to the image: listing not saved to one (use --out to keep it).');
      } catch (e) {
        console.error(`warning: listing not saved into the design's JSON: ${e.message}`);
      }
    }
    console.error(r.designInfo.source === 'sidecar'
      ? `Design info: from ${path.basename(r.designInfo.file)} (sidecar; image not re-read)`
      : `Design info: read from the image${r.designInfo.skipped ? ` (sidecar ${r.designInfo.skipped.map((c) => `${path.basename(c.file)}: ${c.reason}`).join('; ')})` : ''}`);
    const human = [
      ...r.fields.map((f) => `${f.name} (${f.content.length}/${f.maxChars}):\n  ${f.content}`),
      `Keywords / tags, best first (${r.keywords.length}): ${r.keywords.join(', ')}`,
      ...(r.trademarkedKeywords.length
        ? [`Left out — trademarked: ${r.trademarkedKeywords.map((t) => `${t.keyword} (${t.wordmark}, ${t.jurisdiction})`).join('; ')}`]
        : []),
      ...(r.keywordScreen === 'unverified' ? ['Keywords: trademark screen UNVERIFIED — re-run when your trademark data is fresh.'] : []),
      `Trademark: ${r.trademark.status.toUpperCase()}${r.trademark.error ? ` — ${r.trademark.error}` : ''}`,
      ...banHints(r),
      r.trademark.disclaimer,
    ].join('\n');
    output(values, r, human);
    process.exitCode = r.trademark.status === 'clear' || r.trademark.status === 'skipped' ? 0 : r.trademark.status === 'risk' ? 2 : 3;
    return;
  }

  if (cmd === 'listing' && sub === 'screen') {
    if (!rest[0]) throw new Error('Usage: iscale listing screen <file.json>');
    let input = path.resolve(rest[0]);
    const doc = readJsonFile(input, 'listing file');
    // A file saved by `iscale listing generate --out` (fields + keywords): screen it
    // exactly like generate did — each field and each keyword on its own.
    if (!doc.action && !doc.record_type && Array.isArray(doc.fields)) {
      const r = await checkText({
        text: '',
        fields: doc.fields,
        terms: (doc.keywords ?? []).map((k) => (typeof k === 'string' ? k : k?.keyword)).filter(Boolean),
        classes: values.class ?? settings?.config?.trademarkClasses,
        apiBase: apiBase(values, settings),
        allowSingleWord: values['strict-single-word'] ? false : settings?.config?.allowSingleWordTrademarks ?? true,
      });
      r.text = path.basename(input);
      recordListingScreen(r);
      output(values, r, formatCheck(r));
      process.exitCode = EXIT_CODES[r.status];
      return;
    }
    const args = [path.join(repoRoot, 'scripts', 'agentic_dry_run.mjs'), '--input', input, '--trademark-base-url', apiBase(values, settings)];
    if (values.out) args.push('--out', path.resolve(values.out));
    // The screen only talks to allowlisted hosts; the user's own API is allowed.
    const env = { ...process.env, TRADEMARK_ALLOWED_HOST: process.env.TRADEMARK_ALLOWED_HOST || new URL(apiBase(values, settings)).hostname };
    // Same exit codes as `iscale check`: 2 when the screen needs review. (The dry-run
    // script itself keeps exiting 0 with a status field — upload pipelines rely on that.)
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], env });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      process.stdout.write(c);
    });
    const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    let status = null;
    try {
      status = JSON.parse(out).status;
    } catch {
      /* --out was used, or the script failed */
    }
    process.exitCode = code !== 0 ? code : status === 'trademark_review_required' ? 2 : 0;
    return;
  }

  if (cmd === 'listings') {
    const store = loadStore();
    const classes = values.class ?? settings?.config?.trademarkClasses;
    if (sub === 'import') {
      if (!rest[0]) throw new Error('Usage: iscale listings import <etsy-export.csv|listings.json> [--class 025]');
      const r = importListings(store, recordsFromFile(path.resolve(rest[0])), { source: path.basename(rest[0]), classes: values.class });
      saveStore(store);
      return output(values, r, `Imported ${rest[0]}: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped (no title). ${r.total} listings monitored.\nNext: iscale listings scan`);
    }
    if (sub === 'add') {
      const title = rest.join(' ').trim();
      if (!title) throw new Error('Usage: iscale listings add "<title>" [--tag t ...] [--class 025]');
      const r = importListings(store, [{ title, tags: values.tag ?? [] }], { source: 'manual', classes: values.class });
      saveStore(store);
      return output(values, r, `Added. ${r.total} listings monitored.`);
    }
    if (sub === 'list' || !sub) {
      return output(values, store.listings, store.listings.map((l) => `${(l.lastScan?.status ?? 'not scanned').padEnd(12)} ${l.title}`).join('\n') || 'No listings yet. Run: iscale listings import <file>');
    }
    if (sub === 'remove') {
      const before = store.listings.length;
      store.listings = store.listings.filter((l) => l.id !== rest[0]);
      saveStore(store);
      if (before === store.listings.length) throw new Error(`No listing with id ${rest[0]} (see: iscale listings list --json)`);
      return console.log(`Removed ${rest[0]}`);
    }
    if (sub === 'scan') {
      if (!store.listings.length) throw new Error('No listings to scan. Run: iscale listings import <file>');
      const s = await scanListings(store, {
        classes,
        apiBase: apiBase(values, settings),
        allowSingleWord: values['strict-single-word'] ? false : settings?.config?.allowSingleWordTrademarks ?? true,
        includeDescription: values['include-description'],
        ...(values['per-minute'] ? { perMinute: Number(values['per-minute']) } : {}),
        onProgress: (i, n, l, status) => console.error(`[${i}/${n}] ${status.padEnd(10)} ${l.title}`),
      });
      saveStore(store);
      const human = [
        `Scanned ${s.scanned}: ${s.clear} clear, ${s.risk} risk, ${s.unverified} unverified.`,
        ...s.newAlerts.map((a) => `⚠ NEW: "${a.title}" matches ${a.wordmark} (${a.jurisdiction} · class ${a.class} · ${a.status}${a.filingDate ? ` · filed ${a.filingDate}` : ''})`),
        s.incomplete ? 'Coverage is INCOMPLETE; known risk alerts are retained. Fix the coverage gap, then scan again.' : '',
        'Risk screening, not legal advice.',
      ].filter(Boolean).join('\n');
      output(values, s, human);
      process.exitCode = scanCompletionExitCode(s);
      return;
    }
  }

  if (cmd === 'merch') {
    if (sub === 'login') {
      const r = await merchLogin();
      return output(values, r, r.alreadySignedIn ? `Already signed in to Merch (account ${r.accountId}). Next: iscale merch export` : `Signed in to Merch (account ${r.accountId}). Next: iscale merch export`);
    }
    if (sub === 'export') {
      const r = await merchExport({ restart: !!values.restart, headless: !!values.headless });
      const short = r.hitCount && r.hitCount > r.listings ? r.hitCount - r.listings : 0;
      return output(values, r, `Merch catalog complete: ${r.listings.toLocaleString()} listings (${r.liveTitles.toLocaleString()} unique published titles).${short ? `
Merch reported about ${short.toLocaleString()} more; listings created or changed during the export are picked up by the next run.` : ''}
Files in ${r.dir}:
  merch-catalog.csv / merch-catalog.json  (everything)
  merch-catalog-live.csv                  (published, one row per title)
Next: iscale listings import "${path.join(r.dir, 'merch-catalog-live.csv')}"`);
    }
    if (sub === 'status') {
      const r = exportStatus();
      const human = !r.started ? 'No Merch export yet. Run: iscale merch login, then iscale merch export'
        : r.done ? `Export complete: ${r.rows.toLocaleString()} listings (${r.pages} pages, finished ${r.updatedAt}). Files in ${r.dir}
Run iscale merch export again to refresh it.`
          : `Export in progress: page ${r.pages}, ${r.rows.toLocaleString()} listings${r.hitCount ? ` of ~${r.hitCount.toLocaleString()}` : ''}. Run iscale merch export to continue.`;
      return output(values, r, human);
    }
    throw new Error('Usage: iscale merch login | export [--restart] | status');
  }

  if (cmd === 'alerts') {
    const store = loadStore();
    if (values.ack) {
      for (const a of store.alerts) if (values.ack === 'all' || a.key === values.ack || a.listingId === values.ack) a.acknowledged = true;
      saveStore(store);
    }
    const shown = store.alerts.filter((a) => values.all || !a.acknowledged);
    return output(values, shown, shown.map((a) => `${a.firstSeenAt.slice(0, 10)}  "${a.title}" → ${a.wordmark} (${a.jurisdiction} · class ${a.class} · ${a.status})  [${a.key}]`).join('\n') || 'No open alerts.');
  }

  if (cmd === 'setup') {
    if (sub === 'workflow') return console.log(`Workflow: ${setWorkflow(rest[0])}`);
    if (sub === 'review') {
      if (!rest[0] || !rest[1]) throw new Error('Usage: iscale setup review schedule|extension|backup|restore <private-evidence-file>');
      return output(values, recordAcceptance(rest[0], rest[1]), 'Manual evidence review recorded; not an independently verified execution/restore claim.');
    }
    if (sub === 'health') {
      const result = await setupHealth({ apiBase: apiBase(values, settings) });
      output(values, result, result.ready ? 'Private API and both registries are ready.' : 'API or registry coverage is unverified; refresh/check configuration before scanning.');
      process.exitCode = result.ready ? 0 : 3;
      return;
    }
    if (!sub || sub === 'status') {
      const s = await setupStatus({ apiBase: apiBase(values, settings) });
      const human = [
        `iScale setup — database: ${s.database ?? 'not chosen'} · API: ${s.apiBase}`,
        ...s.steps.filter((st) => st.applicable && st.required).map((st) => `  ${st.done ? '✓' : '·'} ${st.id.padEnd(13)}${st.done ? '' : `  → ${st.todo}`}${st.state ? `  [${st.state}${st.followUpDue ? `, follow up ${st.followUpDue}` : ''}]` : ''}`),
        ...s.acceptance.map((item) => `  · ${item.id}: ${item.classification}`),
        ...s.overdueFollowUps.map((o) => `  ⚠ ${o.source} follow-up due ${o.followUpDue} → ${o.todo}`),
        s.next ? `\nNext: ${s.next.todo}` : s.nextAcceptance ? `\nAutomated prerequisites complete. Next manual review: ${s.nextAcceptance.todo}` : '\nAutomated observations complete; manual reviews recorded. Reviews are not independent proof of a schedule or full restore.',
      ].join('\n');
      return output(values, s, human);
    }
    if (sub === 'profile') {
      const { path: p, profile } = saveProfile({
        name: values.name,
        email: values.email,
        country: values.country,
        subscriberType: values['subscriber-type'],
        business: values.business,
        legalEntity: values['legal-entity'],
        website: values.website,
      });
      const missing = missingProfileFields(profile);
      return output(values, { path: p, profile, missing }, missing.length ? `Saved to ${p}. Still needed:\n${missing.map((m) => `  --${m.field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}  ${m.ask}`).join('\n')}` : `Saved to ${p} (stays on this computer).`);
    }
    if (sub === 'database') {
      const s = setDatabase(rest[0]);
      return console.log(`Database: ${s.database}. Follow: iscale setup guide database`);
    }
    if (sub === 'access') {
      const [source, state] = rest;
      const r = recordAccess(source, state, values.note);
      return output(values, r, `${source}: ${r.state}${r.followUpDue ? ` — follow up on ${r.followUpDue} if there's no reply` : ''}`);
    }
    if (sub === 'letters') {
      const profile = loadProfile();
      const missing = missingProfileFields(profile);
      if (missing.length) console.error(`note: profile incomplete (${missing.map((m) => m.field).join(', ')}) — drafts contain [placeholders]. Run: iscale setup profile …`);
      const items = letters(rest[0], profile, { followup: values.followup });
      const files = writeLetters(items, values.out ?? path.join(iscaleHome(), 'letters'));
      return output({ ...values, out: undefined }, { files, letters: items }, `Drafts written:\n${files.map((f) => `  ${f}`).join('\n')}\nReview, attach what's listed, and send from your own email.`);
    }
    if (sub === 'guide') {
      const topic = rest[0] === 'database' ? `database-${loadSetup().database ?? 'supabase'}` : rest[0];
      const file = path.join(repoRoot, 'docs', 'setup', `${topic}.md`);
      if (!topic || !fs.existsSync(file)) throw new Error('Guides: prerequisites, local-walkthrough, database, uspto, uspto-import, euipo, euipo-import, api-auth, schedule, backups, extension');
      return console.log(fs.readFileSync(file, 'utf8'));
    }
    if (sub === 'scheduled') {
      markScheduled();
      return console.log('Schedule configuration recorded as reported. A real trigger/run receipt must still be verified; this does not mark execution complete.');
    }
  }

  if (cmd === 'ai' && sub === 'test') {
    const { engine, model } = pickEngine(values, settings);
    const text = await runEngine({ engine, model, prompt: 'Reply with exactly: iScale OK', timeoutSeconds: 120 });
    return output(values, { ok: true, engine, model: model ?? null, reply: text }, `✓ ${ENGINES[engine].label} answered: ${text}`);
  }

  if (cmd === 'ban' || cmd === 'unban') {
    const term = [sub, ...rest].filter(Boolean).join(' ').trim();
    if (!term) throw new Error(`Usage: iscale ${cmd} "<word or phrase>"`);
    const core = await loadCore();
    const doc = settings ?? { config: structuredClone(core.DEFAULT_LISTING_CONFIG), prefs: {} };
    let config = doc.config;
    let note = '';
    let banned = term.toLowerCase();
    if (cmd === 'ban') {
      // If it's a trademark, ban the part that IS the mark (e.g. "sunshine vibes" out of
      // "sunshine vibes everyday") and record which mark, so the list shows why.
      const r = await checkText({ text: term, classes: config.trademarkClasses, apiBase: apiBase(values, settings), allowSingleWord: true }).catch(() => null);
      const hits = r?.actionable ?? [];
      const hit = hits.find((m) => core.banTermFor(m) === banned) ?? [...hits].sort((a, b) => core.banTermFor(b).length - core.banTermFor(a).length)[0];
      if (hit) banned = core.banTermFor(hit);
      config = core.banTrademark(config, hit
        ? { term: banned, wordmark: hit.wordmark, owner: hit.owner ?? undefined, international_class: hit.international_class, jurisdiction: hit.jurisdiction ?? 'US', registration_status: hit.registration_status, serial_number: hit.serial_number }
        : { term: banned, wordmark: banned.toUpperCase() });
      if (!hit) config.bannedTrademarks = (config.bannedTrademarks ?? []).filter((b) => b.term !== banned);
      note = hit ? ` (trademark ${hit.wordmark}, ${hit.jurisdiction ?? 'US'} class ${hit.international_class}, ${hit.registration_status ?? hit.status})` : '';
      if (hit && banned !== term.toLowerCase()) note += ` — the trademarked part of "${term}"`;
      if (!/\s/.test(banned)) note += '. Note: a single word is now removed from EVERY listing';
    } else {
      config = core.unbanWord(config, term);
    }
    writeSettings({ ...doc, config, updatedAt: new Date().toISOString() });
    return console.log(`${cmd === 'ban' ? 'Banned' : 'Unbanned'} "${banned}"${note}. Shared with the extension next time its panel opens.`);
  }

  if (cmd === 'banned') {
    const config = settings?.config ?? (await loadCore()).DEFAULT_LISTING_CONFIG;
    const tm = new Map((config.bannedTrademarks ?? []).map((b) => [b.term, b]));
    const data = { bannedTrademarks: [...tm.values()], words: config.forbiddenWords.filter((w) => !tm.has(w.toLowerCase())) };
    const human = [
      `Banned trademarks (${data.bannedTrademarks.length}):`,
      ...data.bannedTrademarks.map((b) => `  ™ ${b.term}  — ${b.wordmark}${b.owner ? `, ${b.owner}` : ''} (${[b.jurisdiction, b.international_class && `class ${b.international_class}`, b.registration_status].filter(Boolean).join(', ')}) · ${b.addedAt.slice(0, 10)}`),
      `Other banned words (${data.words.length}): ${data.words.join(', ')}`,
    ].join('\n');
    return output(values, data, human);
  }

  if (cmd === 'settings') {
    if (!sub || sub === 'show') return output(values, settings ?? { note: `No shared settings yet at ${settingsPath()}` });
    if (sub === 'path') return console.log(settingsPath());
    if (sub === 'export') {
      if (!settings) throw new Error('No shared settings to export yet.');
      fs.writeFileSync(path.resolve(rest[0] ?? 'iscale-listings-settings.json'), JSON.stringify(settings, null, 2));
      return console.log(`Exported to ${path.resolve(rest[0] ?? 'iscale-listings-settings.json')}`);
    }
    if (sub === 'import') {
      if (!rest[0]) throw new Error('Usage: iscale settings import <file>');
      const doc = readJsonFile(rest[0], 'settings file');
      const saved = writeSettings({ ...doc, updatedAt: new Date().toISOString() });
      return console.log(`Imported. The extension picks this up next time its panel is focused (updated ${saved.updatedAt}).`);
    }
  }

  throw new Error(`Unknown command: ${positionals.join(' ')}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
