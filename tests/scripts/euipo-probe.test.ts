import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

async function withFakeEuipoServer(run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'fake-token' }));
      return;
    }

    if (request.method === 'GET' && request.url?.startsWith('/trademark-search/trademarks?')) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        type: 'https://dev.euipo.europa.eu/problems-registry/access-forbidden',
        title: 'Forbidden',
        detail: 'Unauthorized request.',
        status: 403,
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start fake EUIPO server');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function runProbe(baseUrl: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      'python',
      [
        'scripts/euipo_search_probe.py',
        '--query',
        'cat dad',
        '--class',
        '25',
        '--size',
        '1',
        '--json',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EUIPO_CLIENT_ID: 'fake-client-id',
          EUIPO_CLIENT_SECRET: 'fake-client-secret',
          EUIPO_AUTH_URL: `${baseUrl}/token`,
          EUIPO_API_BASE: `${baseUrl}/trademark-search`,
        },
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

describe('EUIPO credential probe', () => {
  it('reports token success separately from forbidden trademark search access', async () => {
    await withFakeEuipoServer(async (baseUrl) => {
      const result = await runProbe(baseUrl);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(payload).toMatchObject({
        ok: false,
        stage: 'search',
        token_ok: true,
        search_ok: false,
        http_status: 403,
      });
      expect(payload.detail).toContain('Unauthorized request.');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('Traceback');
    });
  });
});
