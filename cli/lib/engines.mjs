// Your ChatGPT plan as the AI engine, through OpenAI's official Codex SDK
// (@openai/codex-sdk). It runs Codex on this computer with your own `codex login`
// — no API key, no per-request bill. Owner-operated only: never share a helper
// or a sign-in with other people (OpenAI terms).
//
// API-key env vars are removed from the Codex process so a subscription run can
// never silently turn into pay-per-use billing.

import { Codex } from '@openai/codex-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_RE = /^[A-Za-z0-9._:\-/]+$/;
export const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);

// Codex reads `model_reasoning_effort` from ~/.codex/config.toml. Some owners set
// it to a value (e.g. "max") that older models like gpt-5.5 reject with a 400.
// The helper never edits the global config; it clamps effort per thread instead.
const GPT5_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

/** Global Codex settings (model + reasoning effort) from config.toml, best-effort. */
export function readCodexDefaults(env = process.env) {
  try {
    const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.codex');
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const top = toml.split(/^\s*\[/m)[0];
    const pick = (key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1];
    return { model: pick('model'), effort: pick('model_reasoning_effort') };
  } catch {
    return {};
  }
}

/** Per-thread reasoning effort: keep the owner's setting unless the model rejects it. */
export function effortFor(model, defaults = {}) {
  const effective = model || defaults.model || '';
  const effort = defaults.effort;
  if (/^gpt-5/i.test(effective) && effort && !GPT5_EFFORTS.has(effort)) return 'high';
  return undefined;
}

export function environmentWithoutApiKeys(source = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (/_API_KEY$/i.test(key) || key === 'CODEX_API_KEY') continue;
    clean[key] = value;
  }
  return clean;
}

export const ENGINES = {
  codex: { label: 'Codex (your ChatGPT plan)', login: 'codex login' },
};

export function engineNames() {
  return Object.keys(ENGINES);
}

/** Turn an SDK/CLI failure into an actionable message. */
export function explainEngineFailure(engine, message) {
  const spec = ENGINES[engine] ?? ENGINES.codex;
  const tail = String(message ?? '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
  if (/model is not supported|model_not_found|unknown model|invalid model/i.test(tail)) {
    return `${spec.label}: the selected model is not available on your account. Pick another model in iScale settings (or leave it blank to use Codex's default). ${tail}`;
  }
  if (/log ?in|auth|oauth|unauthori[sz]ed|expired|credential/i.test(tail)) {
    return `${spec.label} is not signed in. Run \`${spec.login}\` (choose "Sign in with ChatGPT"), then try again. ${tail}`;
  }
  return `${spec.label} failed. ${tail}`.trim();
}

function writeImage(dataUrl, workdir) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('image must be a base64 data URL');
  const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const file = path.join(workdir, `design.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

/**
 * Run one prompt (optionally with a design image) on the user's ChatGPT plan.
 * A fresh, read-only, network-off Codex thread per job, in a throwaway folder.
 * @param {{ engine?: string, prompt: string, imageBase64?: string, model?: string, reasoningEffort?: string,
 *   timeoutSeconds?: number, env?: NodeJS.ProcessEnv, codexFactory?: (opts: object) => { startThread: Function },
 *   rmDir?: (dir: string, opts: import('node:fs').RmOptions) => void }} request
 * @returns {Promise<string>}
 */
export async function runEngine({ engine = 'codex', prompt, imageBase64, model, reasoningEffort, timeoutSeconds = 300, env = process.env, codexFactory, rmDir = fs.rmSync }) {
  if (!ENGINES[engine]) throw new Error(`Unknown AI engine "${engine}". Use: ${engineNames().join(', ')}`);
  if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt');
  if (model && !MODEL_RE.test(model)) throw new Error(`invalid model name "${model}"`);
  if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) throw new Error('invalid reasoning effort');

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-ai-'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSeconds * 1000);
  try {
    const opts = { env: environmentWithoutApiKeys(env) };
    const effort = reasoningEffort ?? effortFor(model, readCodexDefaults(env));
    const codex = codexFactory ? codexFactory(opts) : new Codex(opts);
    const thread = codex.startThread({
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchEnabled: false,
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
    });
    const input = imageBase64
      ? [{ type: 'text', text: prompt }, { type: 'local_image', path: writeImage(imageBase64, workdir) }]
      : prompt;
    let turn;
    try {
      turn = await thread.run(input, { signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`${ENGINES[engine].label} timed out after ${timeoutSeconds}s`);
      throw new Error(explainEngineFailure(engine, e instanceof Error ? e.message : String(e)));
    }
    const text = String(turn?.finalResponse ?? '').trim();
    if (!text) throw new Error(explainEngineFailure(engine, 'empty response'));
    return text;
  } finally {
    clearTimeout(timer);
    removeWorkdir(workdir, rmDir);
  }
}

// On Windows the Codex sandbox can still hold design.png for a moment after the
// turn ends, so removal fails with EPERM/EBUSY. Retry, then leave the folder for
// the OS temp cleanup — a cleanup failure must never discard a finished answer.
function removeWorkdir(dir, rmDir) {
  try {
    rmDir(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`iscale: could not remove temp folder ${dir}: ${e instanceof Error ? e.message : e}`);
  }
}
