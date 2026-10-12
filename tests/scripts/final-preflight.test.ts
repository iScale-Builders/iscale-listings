import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { PYTHON } from '../helpers/python';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function runPreflight(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(PYTHON, ['scripts/final_preflight.py', ...args], {
      cwd: repoRoot,
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

function runReleaseStatus(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(PYTHON, ['scripts/release_status.py', ...args], {
      cwd: repoRoot,
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

describe('final preflight command', () => {
  it('is exposed through the package scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['final:preflight']).toBe('python scripts/final_preflight.py');
    expect(packageJson.scripts['release:status']).toBe('python scripts/release_status.py');
    expect(packageJson.scripts['git:status']).toBe('python scripts/git_sync_status.py');
  });

  it('lists the release/deploy gates without running them', async () => {
    const result = await runPreflight(['--list', '--json']);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.results.map((item: { name: string }) => item.name)).toEqual([
      'migration dry-run',
      'git hygiene',
      'git sync status',
      'data freshness (US + EU)',
      'unit/type/sdk verification',
      'production build',
      'browser e2e',
    ]);
    expect(payload.results.filter((item: { detail: string }) => item.detail === 'heavy')).toHaveLength(3);
  });

  it('records the as-of date in the output', async () => {
    const result = await runPreflight(['--list', '--as-of', '2026-05-28', '--json']);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(payload.as_of).toBe('2026-05-28');
  });

  it('prints Unicode gate evidence even when Windows starts Python with cp1252 stdout', async () => {
    const code = [
      'from scripts.final_preflight import GateResult, print_results',
      "print_results([GateResult(name='gate', status='fail', exit_code=1, command='check', detail='├ evidence')])",
    ].join('; ');
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(PYTHON, ['-c', code], {
        cwd: repoRoot,
        env: { ...process.env, PYTHONIOENCODING: 'cp1252' },
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
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('├ evidence');
  });
});

describe('release status command', () => {
  it('summarizes the current blocking release gates without running heavy checks', async () => {
    // The git-sync gate reads the REAL repo state. Guarantee a dirty working
    // tree by dropping an untracked marker file (removed in finally) — without
    // it the 'working tree has' blocker only appears when the dev machine
    // happens to be mid-work, and never on CI's clean detached-HEAD checkout.
    const dirtyMarker = path.join(repoRoot, 'release-status-test-dirty-marker.tmp');
    fs.writeFileSync(dirtyMarker, 'temporary file so the git-sync gate reports a dirty tree\n');
    let result: { status: number | null; stdout: string; stderr: string };
    try {
      result = await runReleaseStatus(['--json', '--as-of', '2026-05-28']);
    } finally {
      fs.rmSync(dirtyMarker, { force: true });
    }
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(payload.ready).toBe(false);
    expect(payload.as_of).toBe('2026-05-28');
    // No API runs on localhost:3000 in tests, so the US + EU freshness gate blocks.
    expect(payload.blockers.map((blocker: { gate: string }) => blocker.gate)).toEqual(
      expect.arrayContaining(['data freshness (US + EU)', 'git sync status'])
    );
    const gitSyncBlocker = payload.blockers.find(
      (blocker: { gate: string }) => blocker.gate === 'git sync status'
    );
    expect(gitSyncBlocker.detail).toContain('blocker: working tree has');
    expect(payload.results.find((item: { name: string }) => item.name === 'migration dry-run').status).toBe(
      'pass'
    );
    expect(payload.results.find((item: { name: string }) => item.name === 'production build').status).toBe(
      'skipped'
    );
    expect(payload.results.find((item: { name: string }) => item.name === 'browser e2e').status).toBe(
      'skipped'
    );
  }, 120000); // python subprocess; generous — parallel vitest projects share CPU

  it('prints actionable blocker details in the plain release table', async () => {
    const result = await runReleaseStatus(['--as-of', '2026-05-28']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('- data freshness (US + EU)');
    expect(result.stdout).not.toContain('  complete: false');
    expect(result.stdout).not.toContain('  as_of: 2026-05-28');
  }, 120000); // python subprocess; generous — parallel vitest projects share CPU
});
