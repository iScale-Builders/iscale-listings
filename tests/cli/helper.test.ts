import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { normalizeSettings, readSettings, writeSettings } from '@/cli/lib/settings-store.mjs';
import { createHelperServer, trustExtension } from '@/cli/lib/helper-server.mjs';
import { environmentWithoutApiKeys, explainEngineFailure, runEngine } from '@/cli/lib/engines.mjs';
import { apiKeyPath, trademarkApiKey } from '@/cli/lib/api-key.mjs';

const config = { fields: [{ id: 'title', name: 'Title', maxChars: 60 }], customInstructions: 'be punchy' };

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-home-'));
  env = { ISCALE_HOME: home } as unknown as NodeJS.ProcessEnv;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('shared settings store', () => {
  it('round-trips config and whitelisted prefs, dropping anything secret-shaped', () => {
    writeSettings(
      { config, updatedAt: '2026-09-30T10:00:00.000Z', prefs: { localEngine: 'codex', openaiKey: 'sk-secret', trademarkEnabled: true } },
      env
    );
    const saved = readSettings(env)!;
    expect(saved.config.customInstructions).toBe('be punchy');
    expect(saved.prefs).toEqual({ localEngine: 'codex', trademarkEnabled: true });
    expect(JSON.stringify(saved)).not.toContain('sk-secret');
    expect(saved.updatedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('rejects a document without a listing config', () => {
    expect(() => normalizeSettings({ prefs: {} })).toThrow(/config/);
  });

  it('returns null before anything is shared', () => {
    expect(readSettings(env)).toBeNull();
  });
});

describe('helper server', () => {
  let server: Server;
  let base: string;
  const calls: unknown[] = [];
  beforeEach(async () => {
    calls.length = 0;
    server = createHelperServer({
      env,
      run: async (req: unknown) => {
        calls.push(req);
        return 'generated text';
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const headers = { 'Content-Type': 'application/json', 'X-Iscale-Bridge': '1' };

  it('stores settings from the extension and serves them to the CLI', async () => {
    expect((await fetch(`${base}/settings`, { headers })).status).toBe(404);
    const put = await fetch(`${base}/settings`, { method: 'PUT', headers, body: JSON.stringify({ config, prefs: {} }) });
    expect(put.status).toBe(200);
    const got = await (await fetch(`${base}/settings`, { headers })).json();
    expect(got.config.customInstructions).toBe('be punchy');
    expect(readSettings(env)?.config.customInstructions).toBe('be punchy');
  });

  it('refuses writes without the bridge header and requests from unknown web origins', async () => {
    const noHeader = await fetch(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ config }) });
    expect(noHeader.status).toBe(403);
    const evil = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    // The first extension to connect is the user's own and gets pinned…
    const mine = 'chrome-extension://' + 'a'.repeat(32);
    const other = 'chrome-extension://' + 'b'.repeat(32);
    expect((await fetch(`${base}/health`, { headers: { Origin: mine } })).status).toBe(200);
    expect((await fetch(`${base}/health`, { headers: { Origin: mine } })).status).toBe(200);
    // …any other installed extension is refused, with how to trust a reinstall.
    const denied = await fetch(`${base}/health`, { headers: { Origin: other } });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain(`iscale helper --trust ${'b'.repeat(32)}`);
    trustExtension('b'.repeat(32), env);
    expect((await fetch(`${base}/health`, { headers: { Origin: other } })).status).toBe(200);
    expect(() => trustExtension('not-an-id', env)).toThrow(/not a Chrome extension id/);
  });

  it('refuses localhost web pages and foreign Host headers (audit 2026-10-07)', async () => {
    const page = { Origin: 'http://localhost:5173', 'X-Iscale-Bridge': '1', 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/generate`, { method: 'POST', headers: page, body: JSON.stringify({ prompt: 'read my files' }) })).status).toBe(403);
    expect((await fetch(`${base}/settings`, { method: 'PUT', headers: page, body: JSON.stringify({ config }) })).status).toBe(403);
    expect((await fetch(`${base}/settings`, { headers: { Origin: 'http://127.0.0.1:3000' } })).status).toBe(403);
    // A DNS-rebinding page reaches 127.0.0.1 with its own name in Host and no Origin on GET.
    const port = Number(new URL(base).port);
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/trademark-key', headers: { Host: `attacker.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(rebound).toBe(403);
    expect((await fetch(`${base}/health`)).status).toBe(200); // the CLI / curl: no Origin, loopback Host
  });

  it('serves the machine key to the trusted extension and never to a web page', async () => {
    const mine = 'chrome-extension://' + 'c'.repeat(32);
    expect((await fetch(`${base}/trademark-key`, { headers: { Origin: mine } })).status).toBe(404); // no key yet
    fs.writeFileSync(apiKeyPath(env), 'tk_test_123\n');
    const ok = await fetch(`${base}/trademark-key`, { headers: { Origin: mine } });
    expect(await ok.json()).toEqual({ key: 'tk_test_123' });
    const page = await fetch(`${base}/trademark-key`, { headers: { Origin: 'http://localhost:5173' } });
    expect(page.status).toBe(403);
    const other = await fetch(`${base}/trademark-key`, { headers: { Origin: 'chrome-extension://' + 'd'.repeat(32) } });
    expect(other.status).toBe(403);
  });

  it('ignores a saved engine that no longer exists instead of failing', async () => {
    writeSettings({ config, prefs: { localEngine: 'claude' } }, env);
    const r = await (await fetch(`${base}/generate`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hi' }) })).json();
    expect(r.engine).toBe('codex');
  });

  it('uses the engine from shared settings unless the request names one', async () => {
    writeSettings({ config, prefs: { localEngine: 'codex', localModel: 'gpt-5.5' } }, env);
    const a = await (await fetch(`${base}/generate`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hi' }) })).json();
    expect(a).toEqual({ text: 'generated text', engine: 'codex' });
    await fetch(`${base}/vision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'look', imageBase64: 'data:image/png;base64,AA==', engine: 'codex', model: '' }),
    });
    expect(calls[0]).toMatchObject({ engine: 'codex', model: 'gpt-5.5', prompt: 'hi' });
    expect(calls[1]).toMatchObject({ engine: 'codex', model: undefined, imageBase64: 'data:image/png;base64,AA==' });
  });
});

describe('ChatGPT plan engine (official Codex SDK)', () => {
  it('never passes API keys to the Codex process', () => {
    const clean = environmentWithoutApiKeys({ PATH: "/bin", OPENAI_API_KEY: "x", CODEX_API_KEY: "y" } as unknown as NodeJS.ProcessEnv);
    expect(clean).toEqual({ PATH: '/bin' });
  });

  it('explains an unsupported model and a missing sign-in', () => {
    expect(explainEngineFailure('codex', "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.")).toMatch(/Pick another model/);
    expect(explainEngineFailure('codex', 'Not logged in. Please run codex login')).toMatch(/not signed in/);
  });

  it('runs a fresh read-only, network-off thread with the image and returns the final response', async () => {
    let codexOpts: { env?: Record<string, string> } = {};
    let threadOpts: Record<string, unknown> = {};
    let input: unknown;
    const codexFactory = (opts: { env?: Record<string, string> }) => {
      codexOpts = opts;
      return {
        startThread: (o: Record<string, unknown>) => {
          threadOpts = o;
          return { run: async (i: unknown) => ((input = i), { finalResponse: '  A punchy title \n', items: [], usage: null }) };
        },
      };
    };
    const text = await runEngine({
      prompt: 'Write a title',
      imageBase64: 'data:image/png;base64,AA==',
      model: 'gpt-5.5',
      env: { PATH: '/bin', OPENAI_API_KEY: 'secret' } as unknown as NodeJS.ProcessEnv,
      codexFactory: codexFactory as never,
    });
    expect(text).toBe('A punchy title');
    expect(codexOpts.env).toEqual({ PATH: '/bin' });
    expect(threadOpts).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchEnabled: false, skipGitRepoCheck: true, model: 'gpt-5.5' });
    expect(input).toEqual([
      { type: 'text', text: 'Write a title' },
      { type: 'local_image', path: expect.stringMatching(/design\.png$/) },
    ]);
  });

  it('still returns the answer when the temp folder is locked at cleanup (Windows EPERM)', async () => {
    const codexFactory = () => ({ startThread: () => ({ run: async () => ({ finalResponse: 'the answer' }) }) });
    const rmDir = (dir: string, opts: fs.RmOptions) => {
      fs.rmSync(dir, opts); // don't leak the folder from the test itself
      throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    };
    const text = await runEngine({
      prompt: 'x',
      imageBase64: 'data:image/png;base64,AA==',
      codexFactory: codexFactory as never,
      rmDir: rmDir as never,
    });
    expect(text).toBe('the answer');
  });

  it('turns a sign-in failure into a "run codex login" message', async () => {
    const codexFactory = () => ({ startThread: () => ({ run: async () => { throw new Error('401 Unauthorized: please log in'); } }) });
    await expect(runEngine({ prompt: 'x', codexFactory: codexFactory as never })).rejects.toThrow(/codex login/);
  });

  it('rejects unknown engines and unsafe model names', async () => {
    await expect(runEngine({ engine: 'nope', prompt: 'x' })).rejects.toThrow(/Unknown AI engine/);
    await expect(runEngine({ engine: 'codex', prompt: 'x', model: 'a; rm -rf /' })).rejects.toThrow(/invalid model/);
  });
});

describe('helper auto-start', () => {
  it('builds a hidden Windows launcher that runs this checkout\'s CLI', async () => {
    const { TASK_NAME } = await import('@/cli/lib/autostart.mjs');
    expect(TASK_NAME).toBe('iScale Listings Helper');
  });
});

describe('iscale ban / unban / banned', () => {
  it('bans and unbans a word in the shared settings (offline: recorded as a plain word)', async () => {
    const { execFileSync } = await import('node:child_process');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-ban-'));
    const run = (...a: string[]) =>
      execFileSync(process.execPath, ['cli/iscale.mjs', ...a, '--api', 'http://127.0.0.1:9'], {
        env: { ...process.env, ISCALE_HOME: home },
        encoding: 'utf8',
      });
    try {
      expect(run('ban', 'Casual Friday')).toContain('Banned "casual friday"');
      const saved = readSettings({ ISCALE_HOME: home } as unknown as NodeJS.ProcessEnv);
      expect(saved?.config.forbiddenWords).toContain('casual friday');
      expect(JSON.parse(run('banned', '--json')).words).toContain('casual friday');
      run('unban', 'casual friday');
      expect(readSettings({ ISCALE_HOME: home } as unknown as NodeJS.ProcessEnv)?.config.forbiddenWords).not.toContain('casual friday');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('trademark API key lookup', () => {
  it('prefers TRADEMARK_API_KEY, then the key file, else null', () => {
    expect(trademarkApiKey(env)).toBeNull();
    fs.writeFileSync(apiKeyPath(env), '  from-file  ');
    expect(trademarkApiKey(env)).toBe('from-file');
    expect(trademarkApiKey({ ...env, TRADEMARK_API_KEY: 'from-env' } as NodeJS.ProcessEnv)).toBe('from-env');
  });
});
