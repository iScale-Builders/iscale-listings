# Contributing

Thanks for your interest in improving iScale Listings!

## Development setup

```bash
npm install
```

Requires **Node ≥ 20** and, for the Python data/ops scripts, **Python 3.11+**
(`pip install -r scripts/requirements.txt`).

## Before you open a PR

Run the full local gate — it passes with no secrets/database:

```bash
npm run lint
npx tsc --noEmit
npm run typecheck:extension
npm test
npm run test:sdk
npm run build:extension
```

Or the shortcut: `npm run test:verify` (lint + typecheck + tests + SDK tests).

## Guidelines

- **Keep listing logic in the shared core** (`listing-core-runtime/src/core/`).
  It must stay free of any browser/DOM/`chrome` reference — a guard test
  (`headless.guard.test.ts`) enforces this so the extension and CLI can both use it.
- **Add tests** for behaviour changes, especially in the trademark-matching and
  normalization paths (they're safety-critical — a false "clear" is the worst
  failure mode).
- **Don't break fail-loud behaviour.** Stale-data, DB-unavailable, truncated, and
  rate-limit conditions must surface as errors, never as a silent "clear".
- Keep the diff focused; match the surrounding style.

## Trademark data

This project ships code, not data. Import your own trademark data from the USPTO
ODP / EUIPO with your own access — see [`docs/open-source/`](docs/open-source/).

## Reporting security issues

Please **do not** open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).

## DCO and release boundaries

Use `git commit -s` to certify the [Developer Certificate of Origin](https://developercertificate.org/). No CLA is required. Open an issue before a large change. Never submit credentials, private profiles/cookies, user listings, government identity documents, local deployment details or internal agent files. Preserve the existing MIT license and third-party notices. See [GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [TRADEMARKS.md](TRADEMARKS.md) and [SUPPORT.md](SUPPORT.md).
