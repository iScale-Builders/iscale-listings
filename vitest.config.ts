import { defineConfig } from 'vitest/config';
import path from 'path';

// Two projects so the shared core's own tests run in the same suite:
//  • app  — tests/** for the trademark backend (`@` = repo root)
//  • core — listing-core-runtime/src/**/*.test.ts for the keyword/listing core
//           (`@` = listing-core-runtime/src, matching the core's path alias)
// Before this, the core's *.test.ts files only ran via the core's own vitest
// config, which `npm test` (and CI) never invoked — they were silently skipped.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'app',
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // Many app tests spawn Python/Node subprocesses; on a busy Windows box the
          // full parallel suite routinely took >5 s per spawn (timeout-only failures
          // that pass alone). 30 s keeps real hangs failing without that noise.
          testTimeout: 30_000,
        },
        resolve: {
          // Extension modules import the shared core as `@/core/...` (their esbuild
          // alias); map that first so extension code can be unit-tested here.
          alias: [
            { find: /^@\/core\//, replacement: `${path.resolve(__dirname, 'listing-core-runtime/src/core')}/` },
            { find: '@', replacement: path.resolve(__dirname, '.') },
          ],
        },
      },
      {
        test: {
          name: 'core',
          globals: true,
          environment: 'node',
          include: ['listing-core-runtime/src/**/*.test.ts'],
        },
        resolve: {
          alias: { '@': path.resolve(__dirname, 'listing-core-runtime/src') },
        },
      },
    ],
  },
});
