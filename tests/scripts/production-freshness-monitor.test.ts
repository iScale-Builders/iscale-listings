import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

const requiredEnv = {
  USPTO_API_KEY: 'test',
  TM_DB_URL: 'postgres://example',
  EUIPO_CLIENT_ID: 'test',
  EUIPO_CLIENT_SECRET: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
};

type JurisdictionOverride = Partial<{
  status: string;
  local_database: boolean;
  data_stale: boolean;
  live_mark_count: number;
  sync_date: string;
  source_updated_at: string | null;
  last_synced_at: string;
  freshness_max_age_hours: number;
}>;

function healthBody(overrides: Partial<Record<string, JurisdictionOverride>> = {}) {
  const base = (jurisdiction: string) => ({
    jurisdiction,
    status: 'completed',
    local_database: true,
    data_stale: false,
    live_mark_count: jurisdiction === 'US' ? 4490867 : 598990,
    sync_date: '2026-06-28',
    source_updated_at: jurisdiction === 'US' ? null : '2026-06-28T00:00:00Z',
    last_synced_at: '2026-06-28T22:58:46Z',
    freshness_max_age_hours: jurisdiction === 'US' ? 48 : 168,
    ...overrides[jurisdiction],
  });

  return {
    status: 'ok',
    multi_jurisdiction_schema_ready: true,
    jurisdictions: ['US', 'EUIPO', 'UK'].map(base),
  };
}

function screeningBody(overrides: Record<string, unknown> = {}) {
  return {
    matches: [
      { jurisdiction: 'US', wordmark: 'CAT' },
      { jurisdiction: 'EUIPO', wordmark: 'CAT' },
    ],
    jurisdictions_checked: ['US', 'EUIPO'],
    official_lookup_actions: [],
    data_stale: false,
    ...overrides,
  };
}

async function withHealthServer(
  body: unknown,
  run: (baseUrl: string) => Promise<void>,
  checkBody: unknown = screeningBody()
) {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v1/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }

    if (request.url === '/api/v1/check' && request.method === 'POST') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(checkBody));
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start health fixture');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function cleanMonitorEnv(overrides: Record<string, string | undefined> = requiredEnv): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(requiredEnv)) {
    delete cleanEnv[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete cleanEnv[name];
    } else {
      cleanEnv[name] = value;
    }
  }
  return cleanEnv;
}

function runMonitor(
  baseUrl: string,
  env: Record<string, string | undefined> = requiredEnv,
  extraArgs: string[] = []
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      'python',
      [
        'scripts/production_freshness_monitor.py',
        '--base-url',
        baseUrl,
        ...extraArgs,
        '--json',
      ],
      {
        cwd: repoRoot,
        env: cleanMonitorEnv(env),
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe('production freshness monitor', () => {
  it('passes when required automation env and live jurisdictions are healthy', async () => {
    await withHealthServer(healthBody(), async (baseUrl) => {
      const result = await runMonitor(baseUrl);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(payload.ok).toBe(true);
      expect(payload.failures).toEqual([]);
      expect(payload.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'secret USPTO_API_KEY', status: 'pass' }),
          expect.objectContaining({ name: 'US freshness', status: 'pass' }),
          expect.objectContaining({ name: 'EUIPO freshness', status: 'pass' }),
          expect.objectContaining({ name: 'production screening endpoint', status: 'pass' }),
          expect.objectContaining({ name: 'screening jurisdiction coverage', status: 'pass' }),
          expect.objectContaining({ name: 'screening canary matches', status: 'pass' }),
        ])
      );
    });
  });

  it('fails when health is green but the check route omits EUIPO coverage', async () => {
    await withHealthServer(
      healthBody(),
      async (baseUrl) => {
        const result = await runMonitor(baseUrl);
        const payload = JSON.parse(result.stdout);

        expect(result.status).toBe(1);
        expect(payload.failures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'screening jurisdiction coverage',
              status: 'fail',
              detail: 'missing=EUIPO',
            }),
          ])
        );
      },
      screeningBody({ jurisdictions_checked: ['US'] })
    );
  });

  it('fails when the live check no longer returns a canary match from every registry', async () => {
    await withHealthServer(
      healthBody(),
      async (baseUrl) => {
        const result = await runMonitor(baseUrl);
        const payload = JSON.parse(result.stdout);

        expect(result.status).toBe(1);
        expect(payload.failures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'screening canary matches',
              status: 'fail',
              detail: expect.stringContaining('missing match jurisdictions=EUIPO'),
            }),
          ])
        );
      },
      screeningBody({ matches: [{ jurisdiction: 'US', wordmark: 'CAT' }] })
    );
  });

  it('fails loudly when a live jurisdiction is stale', async () => {
    await withHealthServer(healthBody({ EUIPO: { data_stale: true } }), async (baseUrl) => {
      const result = await runMonitor(baseUrl);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'EUIPO freshness',
            status: 'fail',
            detail: expect.stringContaining('stale'),
          }),
        ])
      );
    });
  });

  it('reports missing workflow secrets without printing values', async () => {
    await withHealthServer(healthBody(), async (baseUrl) => {
      const { USPTO_API_KEY: _removed, ...envWithoutUspto } = requiredEnv;
      const result = await runMonitor(baseUrl, envWithoutUspto);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(payload.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'secret USPTO_API_KEY',
            status: 'fail',
            detail: 'missing or empty in workflow env',
          }),
        ])
      );
      expect(result.stdout).not.toContain('postgres://example');
      expect(result.stdout).not.toContain('test');
    });
  });

  it('writes Markdown and one-line summary files for GitHub issue steps', async () => {
    await withHealthServer(healthBody({ US: { live_mark_count: 0 } }), async (baseUrl) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-'));
      const markdownPath = path.join(dir, 'summary.md');
      const summaryPath = path.join(dir, 'summary.txt');
      const result = await runMonitor(
        baseUrl,
        requiredEnv,
        [
          '--markdown-output',
          markdownPath,
          '--summary-output',
          summaryPath,
        ]
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(markdownPath, 'utf8')).toContain('| US freshness | FAIL | empty live count');
      expect(fs.readFileSync(summaryPath, 'utf8')).toContain('FAIL');
    });
  });
});
