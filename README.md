# iScale Listings

**Protect your print-on-demand shop from trademark trouble.** iScale Listings keeps
your own copy of the US (USPTO) and EU (EUIPO) trademark registers up to date, checks
listings you screen, and can re-check your imported shop after data updates —
so a mark registered *after* your listing went up gets flagged before it becomes a
takedown.

It comes as three pieces that share one brain:

| Piece | What you do with it |
|---|---|
| **Chrome extension** (`extension/`) | Scan any page (Amazon, Etsy, anything) for trademark risks; generate keywords + full listings from a design, validated on Amazon search and trademark-checked. |
| **`iscale` CLI** (`cli/`) | The same things from the terminal or from your AI agent: check any text, generate listings, import your shop and monitor it, guided setup. |
| **Your trademark API** (`app/api/v1/*`) | A small service over **your** database that both of the above talk to. |

The extension and the CLI use **the same settings** (prompt rules, presets, fields,
trademark classes, banned words) through a small local helper.

- **Chrome extension AI:** pick in settings - **your ChatGPT/Codex subscription** (through
  the local helper and OpenAI's official Codex SDK, no per-use billing) **or an OpenAI API
  key** (pay per use, the key stays in Chrome).
- **CLI:** no AI subscription or key needed. **The CLI is run by whichever AI agent is operating it.** `iscale listing generate <image> --agent`
  (the default) hands the writing to that agent - Claude, Codex, Grok, any agent; it writes the
  fields itself, then runs `iscale listing screen <file.json>` / `iscale check`. ChatGPT/Codex
  (e.g. gpt-5.5) is only the Chrome extension's helper engine and is never required for the CLI.

> **Screening, not legal advice.** Results are risk screening. "No conflicts found" is
> not legal clearance, and the database checks words — not logos, artwork, or likenesses.

## Quick start

For a fresh own-PC install, begin with [Windows/macOS prerequisites](docs/setup/prerequisites.md)
and the [single ordered local walkthrough](docs/setup/local-walkthrough.md). Hand
those to your AI; every operation uses existing commands/scripts or a named human
portal/approval step. Accounts can wait for approval while local schema/US work continues.

```bash
git clone https://github.com/iScale-Builders/iscale-listings
cd iscale-listings
npm ci
npm link                 # makes the `iscale` command available (optional: `npm run iscale -- …`)
iscale setup             # checklist → tells you the next step, every time
```

`iscale setup` walks you (or your AI agent) through:

1. **Your database** — your own Supabase project, or local Supabase/Docker. The native Windows/macOS PostgreSQL route is documented separately in [database-postgres.md](docs/setup/database-postgres.md); require its clean-install acceptance.
2. **US data access** — your USPTO.gov account + Open Data Portal key, then the first import.
3. **EU data access** — EUIPO API Portal. The CLI writes the documents email and any
   follow-ups for you (`iscale setup letters euipo`) and tracks the replies.
4. **Automatic updates** — GitHub Actions (hosted database) or a scheduled task on your
   computer (local). Hosted Actions refresh data only; your local shop store requires a separate local scanner.
5. **The extension + your AI** — run `npm run build:extension`, load `extension/dist`, sign in once with
   `npx codex login` (ChatGPT/Codex subscription) or paste an OpenAI API key (extension
   only - the CLI needs neither), and run `iscale helper --install` so the helper starts hidden at every login.

Then follow [private API auth](docs/setup/api-auth.md), [first listing/shop screening](docs/setup/listings.md), [backup/restore](docs/setup/backups.md) and [acceptance](docs/setup/acceptance.md). `iscale setup` reports observed API/data checks and leaves manual browser/scheduler/restore evidence gates pending; configuration is not verified execution.

Guides for every step live in [`docs/setup/`](docs/setup/) (`iscale setup guide <topic>`).

## Everyday use

```bash
iscale check "Retro Cat Dad Club" --class 025         # 0 clear · 2 risk · 3 unverified
iscale listing generate design.png --agent --json    # your AI agent writes it with your settings, then:
iscale listing screen listing.json                     # trademark-screen every field + keyword
iscale listings import EtsyListingsDownload.csv        # Etsy: Shop Manager → Settings → Options → Download Data
iscale merch login && iscale merch export              # Amazon Merch: your whole catalog (resumable) → docs/setup/merch-catalog.md
iscale listings scan --include-description --json --out shop-risk-report.json # title/tags/description; private report
iscale alerts
```

**UNVERIFIED is never "clear."** If your data is stale or a region wasn't searched, every
surface says so instead of showing a green result.

## Using it from an AI agent

Hand the repo to your AI (Claude, Codex…) and say "set this up for me": it reads
[`docs/open-source/agent-entry.md`](docs/open-source/agent-entry.md) (published as `AGENTS.md`)
and walks you through every step. For everyday use, point your agent at
[`skills/iscale-listings/SKILL.md`](skills/iscale-listings/SKILL.md)
(copy it into your agent's skills folder, e.g. `.devin/skills/` or
`.agents/skills/`). The agent can then check anything you write, make listings that are
checked automatically, monitor your shop, and do the setup paperwork with you.

## Repository map

| Path | What |
|---|---|
| `cli/` | `iscale` CLI, local helper (`cli/lib/helper-server.mjs`), AI engines, monitoring, setup |
| `extension/` | Chrome extension (Manifest V3) |
| `listing-core-runtime/src/core/` | The shared listing/keyword/trademark logic used by both extension and CLI |
| `app/api/v1/`, `lib/` | Trademark API (Next.js) — `POST /check`, `POST /check/batch`, `GET /health` |
| `supabase/migrations/` | Database schema |
| `scripts/` | USPTO/EUIPO importers, daily/weekly updates, `refresh-and-scan` |
| `sdk/` | Tiny JavaScript client for the API |
| `skills/` | Agent skill file |

## Development

```bash
npm run test:verify        # lint + typechecks + all tests (no secrets needed)
npm run build:extension    # → extension/dist
```

Node ≥ 20.9, Python 3.11+ for the import scripts (`pip install -r scripts/requirements.txt`).
See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), [SUPPORT.md](SUPPORT.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [TRADEMARKS.md](TRADEMARKS.md) and [NOTICE.md](NOTICE.md). Security reports: [SECURITY.md](SECURITY.md).

## Licences

Code: [MIT](LICENSE). Trademark **data** from the USPTO and EUIPO is governed by those offices' terms.
