import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { PYTHON } from '../helpers/python';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function runHygiene(args: string[] = []) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(PYTHON, ['scripts/pre_git_hygiene.py', ...args], {
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

describe('pre-Git hygiene command', () => {
  it('is exposed through the package scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['git:hygiene']).toBe('python scripts/pre_git_hygiene.py');
  });

  it('passes against the current changed worktree', async () => {
    const result = await runHygiene(['--json']);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.findings).toEqual([]);
  });

  it('blocks high-confidence secret-looking content in untracked files', async () => {
    // Scan an isolated throwaway git repo via --root instead of writing the
    // leak fixture into the real worktree. The worktree-scan test above does a
    // full-repo scan and expects zero findings, so a leak file at the shared
    // repo root races with it under the concurrent suite (and can be stranded
    // by an interrupted run). Isolating the fixture removes the shared state
    // entirely while still exercising untracked-secret detection + redaction.
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-git-hygiene-'));
    const leakName = 'pre-git-hygiene-secret-leak.txt';
    const fakeSecret = `sk-${'proj'}-${'abcdefghijklmnopqrstuvwxyz1234567890'}`;

    try {
      // Mirror the real ignore rules so the only finding is the secret, then
      // make it a git repo so the untracked-file scan has something to list.
      fs.copyFileSync(path.join(repoRoot, '.gitignore'), path.join(scanRoot, '.gitignore'));
      const init = spawnSync('git', ['init', '-q', scanRoot], { encoding: 'utf8' });
      expect(init.status).toBe(0);
      fs.writeFileSync(path.join(scanRoot, leakName), `OPENAI_API_KEY=${fakeSecret}`, 'utf8');

      const result = await runHygiene(['--json', '--root', scanRoot]);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'secret-looking-content',
            path: leakName,
          }),
        ])
      );
      expect(result.stdout).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    } finally {
      fs.rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  it('does not embed project-specific secret literals in its own detector list', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'scripts/pre_git_hygiene.py'), 'utf8');

    expect(source).not.toMatch(/EUIPO.*password/i);
  });
});
