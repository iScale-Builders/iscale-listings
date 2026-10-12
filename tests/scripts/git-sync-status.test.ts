import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { PYTHON } from '../helpers/python';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function runGitStatus(args: string[] = []) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(PYTHON, ['scripts/git_sync_status.py', ...args], {
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

describe('Git sync status command', () => {
  it('is exposed through the package scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['git:status']).toBe('python scripts/git_sync_status.py');
  });

  it('reports read-only Git package readiness as JSON', async () => {
    const result = await runGitStatus(['--json']);
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(payload.ok ? 0 : 1);
    expect(typeof payload.branch === 'string' || payload.branch === null).toBe(true);
    expect(typeof payload.dirty_count).toBe('number');
    expect(typeof payload.ready_for_final_git_package).toBe('boolean');
    expect(Array.isArray(payload.changed_files)).toBe(true);
  });

  it('prints file paths but not file contents', async () => {
    // Inspect an isolated throwaway git repo via --root rather than writing the
    // fixture into the real worktree. This test file runs in parallel with
    // pre-git-hygiene's full-repo worktree-scan (which asserts zero findings),
    // so a secret-looking untracked file at the shared repo root races with it.
    // Isolating the fixture keeps the path-vs-contents assertion intact.
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-status-'));
    const leakName = 'git-sync-status-secret-looking-file.txt';
    const secretLookingContent = `sk-${'proj'}-${'abcdefghijklmnopqrstuvwxyz1234567890'}`;

    try {
      const init = spawnSync('git', ['init', '-q', scanRoot], { encoding: 'utf8' });
      expect(init.status).toBe(0);
      fs.writeFileSync(path.join(scanRoot, leakName), secretLookingContent, 'utf8');

      const result = await runGitStatus(['--json', '--root', scanRoot]);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(payload.changed_files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: leakName,
          }),
        ])
      );
      expect(result.stdout).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    } finally {
      fs.rmSync(scanRoot, { recursive: true, force: true });
    }
  });
});
