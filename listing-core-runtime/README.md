# listing-core-runtime — live shared core (not an app)

This folder is NOT a standalone application. It holds the **live shared
keyword/listing core** that the Chrome extension bundles directly:

- `src/core/` — analysis, keyword generation/validation/ranking, listing
  generation, trademark screening (single source of truth; never fork it).
- `src/lib/` — AI provider abstraction + runtime helpers used by `src/core`.
- `subscription-ai-bridge.mjs` — compatibility entry point for the iScale local
  helper (`iscale helper`, port 18799): your own ChatGPT plan via the official
  Codex SDK, no API key.

Consumers: `extension/build.mjs` + `extension/tsconfig.json` (alias
`@/* → listing-core-runtime/src/*`) and the root `vitest.config.ts` `core`
test project. There is no nested package — dependencies, tests, lint, and
typecheck all run from the repo root.
