# Instructions for AI agents (Claude, Codex, and others)

You were handed the **iScale Listings** repo. It gives a print-on-demand seller their own
private trademark database (US + EU), a Chrome extension that highlights risky words and
writes listings, and the `iscale` CLI that does the same from a terminal. Your job is to
set it up for the user and then use it with them.

## Read first

- **`docs/setup/prerequisites.md`**, then **`docs/setup/local-walkthrough.md`**:
  the single ordered Windows/macOS own-PC setup path, before `npm ci` or imports.
  Keep that walkthrough open instead of guessing order from the progress checklist.

- **`skills/iscale-listings/SKILL.md`**: how to use every command (checks, listings,
  shop monitoring, setup). Follow it.
- **`README.md`**: what the project is and the quick start.
- Guides for each setup step: `docs/setup/` (`iscale setup guide <topic>`).

## Set the user up

```bash
npm ci
npm link            # optional: makes `iscale` available (otherwise: npm run iscale -- …)
iscale setup        # the checklist; it always prints the single next step
```

The checklist reports progress; it is not a one-command installer. The schema,
importers and local lifecycle are checked in. Follow exact commands in the guides;
never invent installer/import code. Current full acceptance requires US **and** EUIPO;
registry selection narrows individual queries only. Native clean-install acceptance
is pending until proven on a clean computer.

For own-PC setup, follow `local-walkthrough.md` in order: prerequisites and account
access → database/schema → US import/catch-up → approved EU import → private API/key
→ extension/CLI/helper → schedule configuration → backup/restore → shop import/scan
and natural-run proof. Run `iscale setup` after each step as a progress diagnostic;
its observed readiness dependencies are not a replacement for that ordered guide.

**Only the person can do these** (tell them exactly what to do, then wait):
- Verify identity with ID.me for the USPTO account.
- Sign in to accounts (USPTO, EUIPO, Supabase, ChatGPT/Codex, Amazon Merch) and enter 2-step codes.
- Send the emails you draft (`iscale setup letters euipo`) only after their explicit approval. Connecting a mailbox alone does not authorize sending.
- Load the unpacked extension in Chrome (Developer mode → Load unpacked → `extension/dist`).

**You can do the rest:** run commands, draft every office email and follow-up, watch for
replies if their inbox is connected, fill `.env.local` from values they give you, schedule
the updates, import and scan their shop.

## After setup: what to offer

- **Check anything for trademarks:** `iscale check "<text>" --class 025`.
- **Make listings:** `iscale listing generate <image> --agent --json` (uses their extension
  settings). **You** write the fields from what it returns, then run `iscale listing screen <file.json>`
  (or `iscale check` per field) and rewrite anything RISK/UNVERIFIED. Never route the CLI through
  ChatGPT/Codex/gpt-5.5 - that is the Chrome extension's helper only. If the
  design has a JSON sidecar with the same name (`design.png` -> `design.json`), its design info is used and the listing is saved back
  into it (`iscale_listings`); keywords double as tags, best first.
- **Amazon Merch sellers, get the whole catalog** (Merch has no export button):
  `docs/setup/merch-catalog.md`: `iscale merch login` (they sign in once) → `iscale merch export`
  (resumable: if it stops, run it again) → `iscale listings import …/merch-catalog-live.csv`.
- **Etsy sellers:** import the shop export with `iscale listings import <csv>`.
- **Protect the shop:** `iscale listings scan` re-checks every listing; with updates scheduled
  run the local scanner after a successful refresh. Hosted Actions do not have the user's local shop store. Show alerts with the mark, owner and status, and suggest a rewrite.

## Rules

- **Never ask for, print, or paste secrets** (API keys, client secrets, passwords, database
  URLs) into the chat. They go into `.env.local` or the user's own settings files.
- **Trademark results are risk screening, not legal advice or clearance.** Say so.
- **UNVERIFIED is never "clear".** If data is stale or a region was not searched, say that.
- Do not make the user's database or API public; the private API key setting
  (`REQUIRE_API_KEY=true`) keeps it to them.
- Everything reads the user's own accounts with their own sign-in. Never automate someone
  else's account.

## Complete the actual acceptance path

Follow `docs/setup/api-auth.md`, `database-postgres.md` only for its separately accepted native route, `listings.md`, `schedule.md`, `backups.md` and `acceptance.md`. Run `iscale setup health --json` for authenticated fresh coverage. Use `--include-description` for full Etsy title/tags/description checks. Keep CSVs/reports/dumps/proof files private. `iscale setup scheduled` reports configuration, not execution; `iscale setup review <topic> <file>` records a human review/hash, not independent verification. Automated next steps and manual acceptance are separate. Never claim actual government approval, a scheduler trigger, offsite copy or full restore from a mock, self-attestation or TOC listing.
