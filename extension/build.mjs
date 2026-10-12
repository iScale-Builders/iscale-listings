// Build the extension into extension/dist (an unpacked, loadable extension).
// Bundles the content script + background service worker with esbuild, then
// copies the manifest and any icons. Run: npm run build:extension
import * as esbuild from 'esbuild';
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = dirname(fileURLToPath(import.meta.url));
const DIST = join(EXT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'content'), { recursive: true });

// The Keywords tab reuses the EXACT keyword-generation functions from the
// local listing-core-runtime folder. Map its `@/` path alias so esbuild bundles them
// straight from that repo's source (single source of truth, no fork).
const KW_SRC = join(EXT, '..', 'listing-core-runtime', 'src');

const common = {
  bundle: true,
  target: 'chrome116',
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
  alias: { '@': KW_SRC },
  // The shared core's trademarkCheck reads process.env.TRADEMARK_API_KEY (a
  // server-only key). There's no Node env in the extension, so fold it to an
  // empty object — the public trademark API needs no key here. (The core has
  // zero other Node deps, so this is the only shim needed.)
  define: { 'process.env': '{}' },
};

await esbuild.build({
  ...common,
  entryPoints: [join(EXT, 'content', 'duo.ts')],
  outfile: join(DIST, 'content', 'duo.js'),
});

await esbuild.build({
  ...common,
  entryPoints: [join(EXT, 'background.ts')],
  outfile: join(DIST, 'background.js'),
});

await esbuild.build({
  ...common,
  entryPoints: [join(EXT, 'sidepanel.ts')],
  outfile: join(DIST, 'sidepanel.js'),
});

cpSync(join(EXT, 'sidepanel.html'), join(DIST, 'sidepanel.html'));
cpSync(join(EXT, 'sidepanel.css'), join(DIST, 'sidepanel.css'));
if (existsSync(join(EXT, 'icons'))) {
  cpSync(join(EXT, 'icons'), join(DIST, 'icons'), { recursive: true });
}
// Manifest LAST: the running extension reloads itself when the version in the
// on-disk manifest changes (background.ts self-update), so it must only appear
// once every other file of the new build is in place.
cpSync(join(EXT, 'manifest.json'), join(DIST, 'manifest.json'));

console.log('Extension built -> extension/dist  (chrome://extensions -> Load unpacked -> select extension/dist)');
