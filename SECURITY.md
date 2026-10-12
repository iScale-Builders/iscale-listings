# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Email **contact@iscalelabs.com** with a sanitized description. Do not send keys, cookies, production databases or user documents. Agree on a private channel before sharing sensitive reproduction material. GitHub private vulnerability reporting may be offered as a secondary channel once the release repository is public and that feature is enabled; do not rely on it while the repository is private.

Include, where possible:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept helps),
- affected component (API, extension, SDK, or bridges) and version/commit.

We'll acknowledge your report, investigate, and coordinate a fix and disclosure
timeline with you.

## Scope notes

- The **local AI bridges** (`listing-core-runtime/*-bridge.mjs`) run an HTTP server
  on `127.0.0.1` that shells out to a local AI CLI. They enforce an origin
  allowlist and a required header so arbitrary web pages can't drive them, but they
  are opt-in developer tools — only run a bridge on a machine you trust.
- Trademark screening results are **risk screening, not legal advice**.
- Trademark data terms (USPTO/EUIPO) are separate from this project's code license.
