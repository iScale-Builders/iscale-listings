// The iScale local helper: one small loopback server that
//   1. holds the shared settings file (extension <-> CLI), and
//   2. runs AI requests on the user's own ChatGPT plan (official Codex SDK).
//
// It keeps the old subscription-bridge contract (GET /health, POST /generate,
// POST /vision on port 18799) so existing extension installs keep working.
// Owner-operated only: it binds to 127.0.0.1 and must not be shared with others
// (each user signs in to their own AI account).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ENGINES, runEngine, engineNames, REASONING_EFFORTS } from './engines.mjs';
import { iscaleHome, readSettings, settingsPath, writeSettings } from './settings-store.mjs';
import { trademarkApiKey } from './api-key.mjs';

export const DEFAULT_HELPER_PORT = 18799;
const MAX_BODY = 12 * 1024 * 1024;

// Only YOUR iScale Listings extension may use the helper (and so your ChatGPT
// plan) — not any other extension installed in the same Chrome. The first
// extension that connects is remembered; others get a 403 telling the user how to
// trust a reinstalled copy (`iscale helper --trust <id>`).
export function trustPath(env = process.env) {
  return path.join(iscaleHome(env), 'helper-trust.json');
}

export function trustedExtensionIds(env = process.env) {
  const fromEnv = (env.ISCALE_HELPER_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const ids = JSON.parse(fs.readFileSync(trustPath(env), 'utf8')).extensionIds;
    return [...new Set([...fromEnv, ...(Array.isArray(ids) ? ids : [])])];
  } catch {
    return fromEnv;
  }
}

export function trustExtension(id, env = process.env) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`"${id}" is not a Chrome extension id (32 letters a–p; see chrome://extensions).`);
  const ids = [...new Set([...trustedExtensionIds({ ...env, ISCALE_HELPER_EXTENSION_IDS: '' }), id])];
  fs.mkdirSync(path.dirname(trustPath(env)), { recursive: true });
  fs.writeFileSync(trustPath(env), JSON.stringify({ extensionIds: ids }, null, 2));
  return ids;
}

/** 'allow' | 'deny' | null (no Origin: a local program such as the CLI or curl). */
function checkOrigin(origin, env) {
  if (!origin) return null;
  // Web pages are never allowed, localhost ones included: a page from any local dev
  // server could otherwise spend the user's AI plan, rewrite their prompt settings
  // and ask the (file-reading) model for local files. Only the trusted extension.
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m) return 'deny';
  const trusted = trustedExtensionIds(env);
  if (!trusted.length) {
    trustExtension(m[1], env); // first extension to connect = the user's own
    return 'allow';
  }
  return trusted.includes(m[1]) ? 'allow' : 'deny';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Engine + model for a request: explicit body values win, then shared settings. */
function pickEngine(body, env) {
  let prefs = {};
  try {
    prefs = readSettings(env)?.prefs ?? {};
  } catch {
    /* unreadable settings: fall back to defaults */
  }
  // A saved engine that no longer exists (e.g. 'claude' from an older version) falls back to Codex.
  const saved = ENGINES[prefs.localEngine] ? prefs.localEngine : 'codex';
  const engine = typeof body.engine === 'string' && body.engine ? body.engine : saved;
  const model = typeof body.model === 'string' ? body.model : prefs.localModel || env.SUBAI_CODEX_MODEL || '';
  return { engine, model: model.trim() || undefined };
}

// The helper listens on loopback only; any other Host means a DNS-rebinding page.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function loopbackHost(hostHeader) {
  return LOOPBACK_HOSTS.has(String(hostHeader || '').toLowerCase().replace(/:\d+$/, ''));
}

export function createHelperServer({ env = process.env, run = runEngine, version = 'dev' } = {}) {
  return http.createServer(async (req, res) => {
    if (!loopbackHost(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    const verdict = checkOrigin(req.headers.origin, env);
    if (verdict === 'allow') res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Iscale-Bridge');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // A web page or another extension must never drive the helper.
    if (verdict === 'deny') {
      const ext = /^chrome-extension:\/\/([a-p]{32})$/.exec(req.headers.origin || '');
      return send(res, 403, {
        error: ext
          ? `This extension (${ext[1]}) is not trusted by the iScale helper. If you reinstalled iScale Listings, run: iscale helper --trust ${ext[1]}`
          : 'forbidden origin',
      });
    }

    const url = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/health') {
        let settings = null;
        try {
          settings = readSettings(env);
        } catch {
          /* reported as missing */
        }
        return send(res, 200, {
          ok: true,
          backend: 'iscale-helper',
          version,
          engines: engineNames(),
          settings: { path: settingsPath(env), updatedAt: settings?.updatedAt ?? null },
        });
      }
      if (req.method !== 'GET' && req.headers['x-iscale-bridge'] !== '1') {
        return send(res, 403, { error: 'forbidden: missing X-Iscale-Bridge header' });
      }
      if (req.method === 'GET' && url === '/trademark-key') {
        // Only the trusted iScale extension (or a local program) gets the key:
        // never a localhost web page.
        const origin = req.headers.origin || '';
        if (origin && !/^chrome-extension:\/\//.test(origin)) return send(res, 403, { error: 'forbidden origin' });
        const key = trademarkApiKey(env);
        return key ? send(res, 200, { key }) : send(res, 404, { error: 'no trademark API key on this machine' });
      }
      if (req.method === 'GET' && url === '/settings') {
        const settings = readSettings(env);
        return settings ? send(res, 200, settings) : send(res, 404, { error: 'no shared settings yet' });
      }
      if (req.method === 'PUT' && url === '/settings') {
        const saved = writeSettings(await readJson(req), env);
        return send(res, 200, { ok: true, updatedAt: saved.updatedAt });
      }
      if (req.method === 'POST' && (url === '/generate' || url === '/vision')) {
        const body = await readJson(req);
        if (!body.prompt || typeof body.prompt !== 'string') return send(res, 400, { error: 'missing prompt' });
        if (url === '/vision' && !body.imageBase64) return send(res, 400, { error: 'missing imageBase64' });
        if (body.reasoningEffort !== undefined && !REASONING_EFFORTS.has(body.reasoningEffort)) return send(res, 400, { error: 'invalid reasoning effort' });
        const { engine, model } = pickEngine(body, env);
        const text = await run({
          engine,
          model,
          ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
          prompt: body.prompt,
          imageBase64: url === '/vision' ? body.imageBase64 : undefined,
          timeoutSeconds: Number(url === '/vision' ? env.SUBAI_VISION_TIMEOUT || 300 : env.SUBAI_TEXT_TIMEOUT || 180),
          env,
        });
        return send(res, 200, { text, engine });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e?.status ?? 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export function startHelper({ port = Number(process.env.ISCALE_HELPER_PORT || process.env.SUBAI_BRIDGE_PORT || DEFAULT_HELPER_PORT), version } = {}) {
  const server = createHelperServer({ version });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`iScale helper listening on http://127.0.0.1:${port}`);
      console.log(`  shared settings: ${settingsPath()}`);
      console.log(`  AI engines: ${engineNames().join(', ')} (your own sign-in, no API key)`);
      resolve(server);
    });
  });
}
