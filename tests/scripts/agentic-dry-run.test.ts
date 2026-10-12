import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function runDryRun(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['scripts/agentic_dry_run.mjs', ...args], {
      cwd: repoRoot,
      env: { ...process.env },
    });

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

function completeTrademarkResponse(overrides: Record<string, unknown> = {}) {
  return {
    matches: [],
    total_matches: 0,
    truncated: false,
    data_last_synced: '2026-07-24T00:00:00.000Z',
    data_stale: false,
    jurisdictions_checked: ['US', 'EUIPO'],
    official_lookup_actions: [],
    ...overrides,
  };
}

describe('agentic dry-run command', () => {
  it('is exposed through the package scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['agentic:dry-run']).toBe('node scripts/agentic_dry_run.mjs');
  });

  it('validates keywords offline from fixture autosuggest data', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-keyword-validation.json',
      '--offline',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload).toEqual({
      action: 'iscale.keyword.validate',
      mode: 'offline',
      status: 'done',
      validated: [
        {
          word: 'cat dad',
          certified: true,
          unverified: false,
          bestPosition: 1,
          bestVariant: 'shirt',
        },
        {
          word: 'retro',
          certified: false,
          unverified: false,
          bestPosition: null,
          bestVariant: null,
        },
      ],
      warnings: [],
    });
  });

  it('refuses a live trademark check against a host that is not allowlisted', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-trademark-check.json',
      '--trademark-base-url',
      'https://evil.example',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not allowlisted');
  });

  it('plans trademark checks without live calls', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-trademark-check.json',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload).toEqual({
      action: 'iscale.trademark.check',
      mode: 'plan',
      status: 'planned',
      request: {
        text: 'Funny cat dad shirt',
        classes: ['025'],
        include_dead: false,
        jurisdictions: ['US', 'EUIPO'],
      },
      live_call: false,
      warnings: [
        'Trademark results are risk screening, not legal clearance.',
        'EUIPO may return official_lookup_actions unless local coverage is available.',
      ],
    });
  });

  it('plans a full listing generation offline without calling any provider', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate.json',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload).toEqual({
      action: 'iscale.listing.generate',
      mode: 'plan',
      status: 'planned',
      live_call: false,
      plan: {
        marketplace: 'amazon-merch',
        validateEnabled: true,
        trademarkEnabled: true,
        steps: ['analyze', 'generate', 'validate', 'rank', 'listing', 'trademark'],
        fields: [
          { id: 'title', name: 'Title', maxChars: 60 },
          { id: 'brand', name: 'Brand', maxChars: 50 },
          { id: 'bullet-1', name: 'Bullet Point Description', maxChars: 256 },
          { id: 'bullet-2', name: 'Bullet Point Description', maxChars: 256 },
        ],
      },
      warnings: [
        'Plan mode does not call an AI model, Amazon, or the trademark API.',
        'The CLI is for use with a calling AI agent; it does not select or call an AI provider.',
        'Trademark results are risk screening, not legal clearance.',
      ],
    });
  });

  it('reads an image file path and plans the listing', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate-path.json',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload.action).toBe('iscale.listing.generate');
    expect(payload.status).toBe('planned');
    expect(payload.plan.steps).toEqual(['analyze', 'generate', 'listing']);
  });

  it('writes the result to --out instead of stdout', async () => {
    const outPath = path.join(os.tmpdir(), `iscale-cli-out-${process.pid}.json`);
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate.json',
      '--out',
      outPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Wrote');
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(written.action).toBe('iscale.listing.generate');
    expect(written.status).toBe('planned');
    fs.unlinkSync(outPath);
  });

  it('errors when neither --input nor --image is provided', async () => {
    const result = await runDryRun([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--input');
  });

  it('applies exported UI settings via --config (presets/fields carry to the CLI)', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate.json',
      '--config',
      'tests/fixtures/agentic-control/sample-settings-export.json',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    // The plan reflects the exported config's fields, not the Amazon defaults.
    expect(payload.plan.fields).toEqual([
      { id: 'headline', name: 'Headline', maxChars: 100 },
      { id: 'tagline', name: 'Tagline', maxChars: 80 },
    ]);
  });

  it('rejects direct provider execution because the CLI is agent-owned', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate-live.json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('UI-only');
  });

  it('returns a provider-agnostic task only for a calling AI agent', async () => {
    const result = await runDryRun([
      '--input',
      'tests/fixtures/agentic-control/sample-listing-generate.json',
      '--mode',
      'agent',
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(payload).toMatchObject({
      action: 'iscale.listing.generate',
      mode: 'agent',
      status: 'awaiting_agent',
      live_call: false,
      agent_required: true,
      agent_task: {
        marketplace: 'amazon-merch',
        steps: ['analyze', 'generate', 'validate', 'rank', 'listing', 'trademark'],
      },
    });
    expect(payload.agent_task.rule).toContain('calling AI agent');
  });

  it('does not accept UI provider flags in the agent CLI', async () => {
    const result = await runDryRun([
      '--image',
      'tests/fixtures/agentic-control/tiny.png',
      '--provider',
      'openai',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument: --provider');
  });

  it('runs a governed anonymous live trademark check and fails closed on incomplete coverage', async () => {
    const server = http.createServer((request, response) => {
      expect(request.url).toBe('/api/v1/check');
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        matches: [],
        total_matches: 0,
        truncated: false,
        query_time_ms: 4,
        data_last_synced: '2026-07-24T00:00:00.000Z',
        data_stale: false,
        jurisdictions_requested: ['US', 'EUIPO'],
        jurisdictions_checked: ['US'],
        official_lookup_actions: [{ jurisdiction: 'EUIPO' }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const result = await runDryRun([
        '--input',
        'tests/fixtures/agentic-control/sample-trademark-check.json',
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      const payload = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(payload.mode).toBe('live');
      expect(payload.live_call).toBe(true);
      expect(payload.final_result).toBe('trademark_review_required');
      expect(payload.coverage_problems).toEqual([
        'jurisdiction_not_checked:EUIPO',
        'official_lookup_required',
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each(['truncated', 'data_stale', 'data_last_synced', 'official_lookup_actions'])(
    'rejects a live trademark response missing required %s metadata',
    async (field) => {
      const responseBody = completeTrademarkResponse() as Record<string, unknown>;
      delete responseBody[field];
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(responseBody));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      try {
        const result = await runDryRun([
          '--input',
          'tests/fixtures/agentic-control/sample-trademark-check.json',
          '--trademark-base-url',
          `http://127.0.0.1:${address.port}`,
        ]);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(field);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('keeps the shared famous-brand policy actionable in the agentic CLI', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(completeTrademarkResponse({
        matches: [{
          wordmark: 'XBOX',
          matched_text: 'xbox',
          registration_status: 'registered',
          confidence: 'low',
        }],
        total_matches: 1,
      })));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const result = await runDryRun([
        '--input',
        'tests/fixtures/agentic-control/sample-trademark-check.json',
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      const payload = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(payload.final_result).toBe('trademark_review_required');
      expect(payload.actionable_matches).toHaveLength(1);
      expect(payload.actionable_matches[0].policy_reason).toBe('famous_single_word');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('screens the words it is given and nothing else: no product-noun gate, description and keywords optional', async () => {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        try { seen.push(JSON.parse(body).text); } catch { seen.push('(unparsed)'); }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          matches: [],
          total_matches: 0,
          truncated: false,
          query_time_ms: 2,
          data_last_synced: '2026-07-24T00:00:00.000Z',
          data_stale: false,
          jurisdictions_requested: ['US', 'EUIPO'],
          jurisdictions_checked: ['US', 'EUIPO'],
          official_lookup_actions: [],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const inputPath = path.join(os.tmpdir(), `iscale-listing-screen-words-${process.pid}.json`);
    fs.writeFileSync(inputPath, JSON.stringify({
      action: 'iscale.listing.screen',
      mode: 'live',
      listing: {
        title: 'Retro Teacher Shirt',
        brand: 'LessonLumen Studio',
        bullets: ['Colorful classroom art.', 'For dedicated teachers.'],
      },
    }));
    try {
      const result = await runDryRun([
        '--input',
        inputPath,
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('done');
      expect(payload.trademark_receipt.fields_checked.map((item: { field: string }) => item.field))
        .toEqual(['title', 'brand', 'bullet1', 'bullet2']);
      expect(seen).toEqual([
        'Retro Teacher Shirt',
        'LessonLumen Studio',
        'Colorful classroom art.',
        'For dedicated teachers.',
      ]);
    } finally {
      fs.unlinkSync(inputPath);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('refuses only a listing with no text to screen', async () => {
    const inputPath = path.join(os.tmpdir(), `iscale-listing-screen-empty-${process.pid}.json`);
    fs.writeFileSync(inputPath, JSON.stringify({
      action: 'iscale.listing.screen',
      mode: 'live',
      listing: { title: '  ', bullets: ['', null], keywords: [' '] },
    }));
    try {
      const result = await runDryRun([
        '--input',
        inputPath,
        '--trademark-base-url',
        'http://127.0.0.1:1',
      ]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('listing has no text to screen');
    } finally {
      fs.unlinkSync(inputPath);
    }
  });

  it('screens every listing field and returns a current passing receipt', async () => {
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        matches: [],
        total_matches: 0,
        truncated: false,
        query_time_ms: 3,
        data_last_synced: '2026-07-24T00:00:00.000Z',
        data_stale: false,
        jurisdictions_requested: ['US', 'EUIPO'],
        jurisdictions_checked: ['US', 'EUIPO'],
        official_lookup_actions: [],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const result = await runDryRun([
        '--input',
        'tests/fixtures/agentic-control/sample-listing-screen.json',
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      const payload = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(requestCount).toBe(6);
      expect(payload.status).toBe('done');
      expect(payload.trademark_receipt).toMatchObject({
        final_result: 'pass',
        receipt_stale: false,
        review_required: false,
        jurisdictions_checked: ['US', 'EUIPO'],
      });
      expect(payload.trademark_receipt.fields_checked.map((item: { field: string }) => item.field))
        .toEqual(['title', 'brand', 'bullet1', 'bullet2', 'description', 'keywords']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('derives receipt staleness from stale field metadata', async () => {
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(completeTrademarkResponse({
        data_stale: requestCount === 1,
      })));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const result = await runDryRun([
        '--input',
        'tests/fixtures/agentic-control/sample-listing-screen.json',
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      const payload = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(payload.status).toBe('trademark_review_required');
      expect(payload.trademark_receipt.receipt_stale).toBe(true);
      expect(payload.trademark_receipt.coverage_problems).toContain('title:data_stale');
      expect(payload.trademark_receipt.final_result).toBe('trademark_review_required');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('screens the exact listing from a matched POD asset sidecar', async () => {
    const inputPath = path.join(os.tmpdir(), `iscale-sidecar-screen-${process.pid}.json`);
    fs.writeFileSync(inputPath, JSON.stringify({
      record_type: 'amazon_merch_upload_asset',
      listing: {
        title: 'Little Lessons Lasting Light Retro Teacher Art',
        brand: 'LessonLumen Studio',
        bullets: ['Retro academic lettering and graphics.', 'For dedicated teachers.'],
        description: 'Colorful academic artwork celebrating teachers, curiosity, and lasting lessons.',
        keywords: ['lasting lessons', 'teacher art'],
      },
      trademark_screening: {
        jurisdictions: ['US', 'EUIPO'],
        international_classes: ['025'],
        include_dead: false,
      },
    }));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        matches: [],
        total_matches: 0,
        truncated: false,
        data_last_synced: '2026-07-24T00:00:00.000Z',
        data_stale: false,
        jurisdictions_checked: ['US', 'EUIPO'],
        official_lookup_actions: [],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const result = await runDryRun([
        '--input',
        inputPath,
        '--trademark-base-url',
        `http://127.0.0.1:${address.port}`,
      ]);
      const payload = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(payload.action).toBe('iscale.listing.screen');
      expect(payload.listing.keywords).toEqual(['lasting lessons', 'teacher art']);
      expect(payload.trademark_receipt.final_result).toBe('pass');
    } finally {
      fs.unlinkSync(inputPath);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
