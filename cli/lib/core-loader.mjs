// Load the shared TypeScript listing core into Node. esbuild bundles
// listing-core-runtime/src/core/cli-entry.ts in memory (same `@` alias as the extension build) and we
// import the result from a data URL — no build step for users to run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let corePromise;

export function loadCore() {
  corePromise ??= (async () => {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [path.join(repoRoot, 'listing-core-runtime', 'src', 'core', 'cli-entry.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      sourcemap: false,
      logLevel: 'silent',
      alias: { '@': path.join(repoRoot, 'listing-core-runtime', 'src') },
    });
    const code = result.outputFiles[0].text;
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  })();
  return corePromise;
}
