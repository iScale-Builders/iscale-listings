# iScale Listings Secrets Policy

This document describes secret-bearing files and patterns that must never be
committed. It is referenced by `.github/workflows/pre-merge.yml`.

## Never commit

- `.env` and every `.env.*` variant, including `.env.production` and
  `.env.*.local`; placeholder-only `.env.example` / `.env.*.example` files are
  the explicit filename exception and must never contain real values
- `credentials.md` or any `credentials/` directory
- `.pem`, `.key`, `.p8`, `.p12`, `.pfx` files
- Service-account JSON files (`service-account*.json`, `*-credentials.json`)
- API keys, tokens, passwords, private keys, or database URLs with real values
- Browser/session storage files (`.playwright/.auth/`, `storage-state*.json`, `*.har`)
- Local databases (`.db`, `.sqlite`, `.sqlite3`)

## How secrets are kept out of PRs

- `.gitignore` blocks the file patterns above.
- The `file-deny` CI job rejects the filenames in a PR diff.
- The `secrets-scan` CI job runs gitleaks on the PR diff.
- The `pii-scrub` CI job rejects added lines matching common PII/secret patterns.

## If a secret is leaked

1. Do not commit the fix while the secret is still in the diff.
2. Rotate or revoke the leaked credential through its provider.
3. Scrub the value from history if it reached a branch.
4. Update the credential in your own secret store (never in the repo).

## Local development

- Copy `.env.local.example` to `.env.local` and fill in real values locally.
- Never put real values in example files, READMEs, or comments.
- Keep real credential files out of screenshots and terminal output.
