import { spawnSync } from 'node:child_process';

/**
 * The Python interpreter used by tests that shell out to `scripts/*.py`.
 *
 * Resolved once, in this order: `$PYTHON` override → `python3` (present on stock
 * macOS and most Linux) → `python` (Windows). The suite previously hardcoded
 * `python`, which doesn't exist on a fresh macOS/Linux box, so `npm test` failed
 * for any contributor not on Windows.
 */
function resolvePython(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  // Windows real installs expose `python`; `python3` there is often the Store
  // stub. macOS/Linux expose `python3`. Try the platform-likely name first.
  const order = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const bin of order) {
    const result = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return bin;
  }
  return order[order.length - 1];
}

export const PYTHON = resolvePython();
