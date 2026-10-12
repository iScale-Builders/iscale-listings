# iScale Listings CI Policy

This document explains the repository's pre-merge Continuous Integration (CI)
contract. It is referenced by `.github/workflows/pre-merge.yml`.

## Scope

Every pull request against `main` must pass the jobs in
`.github/workflows/pre-merge.yml` before it can merge. These jobs verify
security, style, type safety, unit tests, and build artifacts.

## Jobs

| Job | Purpose |
| --- | --- |
| `secrets-scan` | Detect secrets in the PR diff with gitleaks. |
| `file-deny` | Reject denied filenames (`.env`, credential files, keys, etc.). |
| `pii-scrub` | Reject PII patterns (Windows user paths, personal email domains, private IPv4 ranges) in added lines. |
| `python-lint` | Lint and syntax-check changed Python files with ruff. |
| `next-typecheck` | Typecheck the Next.js app, extension, and listing core. |
| `lint` | Run ESLint over `app/`, `extension/`, `lib/`, and `sdk/`. |
| `tests` | Run the Vitest unit-test suite (app + core projects). |
| `dependency-audit` | Run `npm audit --omit=dev --audit-level=high` to block high/critical production vulnerabilities. |
| `sdk-tests` | Run the SDK unit-test suite. |
| `extension-build` | Build the Chrome extension with `npm run build:extension`. |

## Why no full `next build` in CI

`next build` currently requires live Supabase connection values at build time.
We do not plumb production secrets into CI. The Vercel preview deploy attached
to each PR exercises the full production build path against staging-style
environment values.

## When CI fails

1. Read the failing job log.
2. Fix the root cause in source, lockfile, or workflow.
3. Re-push the branch. Do not bypass or weaken a failing gate.

## Lockfile discipline

- Use Node 20 and npm 10 for lockfile changes.
- After editing `package.json`, regenerate the lockfile with
  `npx npm@10 install --package-lock-only`.
- Verify with `npx npm@10 ci --dry-run` before committing.
- This machine runs npm 11 locally, which can prune optional WASM dependencies
  that CI npm 10 requires; always regenerate with npm 10.
