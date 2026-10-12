---
name: iscale-listings
description: Screen any text for US/EU trademark risk, write print-on-demand listings that are automatically trademark-checked, monitor a whole Etsy/Amazon shop for newly registered conflicting marks, and guide the user through setting up their own trademark database and official USPTO/EUIPO data access — all through the `iscale` CLI. Use whenever the user mentions trademarks, a phrase/keyword/tag being "safe", Etsy or Amazon Merch listings, keywords, shop monitoring, or setting up iScale Listings.
---

# iScale Listings — agent skill

You operate the `iscale` CLI from this repository. Run it as `iscale …` if the user
ran `npm link`, otherwise `node cli/iscale.mjs …` (or `npm run iscale -- …`) from the
repo root. Add `--json` whenever you need to read the result.

## Non-negotiable rules

1. **A trademark result is risk screening, not legal advice.** Never tell the user a
   phrase is "legal", "safe to use" or "cleared". Say "no conflicts found in the US and
   EU databases for class 025 as of <date>" and suggest an attorney for anything important.
2. **UNVERIFIED is not clear.** Exit code 3 / `status: "unverified"` means the check did
   not fully happen (stale data, a region not searched, API down). Report it as
   unverified, say why (`reason`), and fix the cause — never round it up to clear.
3. **Text only.** The database screens words. Logos, lookalike artwork, characters,
   celebrity likenesses and copyrighted art are not screened — look at the image
   yourself and warn about anything like that.
4. **Secrets never go through the chat.** API keys, database URLs, client secrets and
   passwords go into `.env.local` by the user (or by you writing the file without
   echoing values). Never print them, never commit them.
5. **Never send an email or submit a form for the user without their explicit OK for
   that specific message.** Drafting is always fine.
6. Use only the user's own AI sign-in; the helper is for one person's machine.
7. **You run the CLI and you write the listings.** `iscale listing generate <image> --agent`
   (the default) hands the writing to you - Claude, Codex, Grok, any agent; you write the
   fields yourself, then runs `iscale listing screen <file.json>` / `iscale check`. ChatGPT/Codex
   (e.g. gpt-5.5) is only the Chrome extension's helper engine and is never required for the CLI.
   Never run bare `iscale listing generate` expecting a model, never change the user's
   Codex/ChatGPT config to make the CLI work, and never tell the user they need ChatGPT,
   Codex or an OpenAI key for the CLI.

## Exit codes

`0` clear · `2` risk (or new alerts) · `3` unverified (NOT clear) · `1` error.

## 1. Check anything for trademarks

```bash
iscale check "Retro Cat Dad Club" --class 025 --json
iscale check --term "cat dad" --term "funny cat" --class 025 021 --json   # keywords/tags one by one
```

Classes (Nice): `025` apparel, `021` drinkware, `009` phone cases, `018` bags,
`020` home decor, `024` textiles. With no `--class`, the user's chosen classes from
their shared settings are used. Read `actionable` (blocking matches) vs
`informational` (ordinary single-word registrations the user's policy doesn't block;
famous brands like NIKE are always actionable). Use this freely whenever you write
customer-facing copy for the user.

## 2. Make a listing (auto-checked)

The listing uses the user's own settings from the Chrome extension (prompt rules,
presets, field limits, banned words, trademark classes) through the shared settings
file — so make sure the helper runs (`iscale helper --status`; `iscale helper --install`
starts it hidden at every login).

- **You write it (the default, always use this):**
  `iscale listing generate design.png --agent --json` returns the user's instructions,
  fields with `maxChars`, `forbiddenWords` and `trademarkClasses`. If it includes
  `designInfo` (from the design's JSON sidecar), use that as the description and its
  `detectedText` as the exact text on the design; otherwise look at the image. Then
  write every field within its limit and save
  `{"fields":[{"name":"Title","content":"..."}, ...],"keywords":["...", ...]}` to a file, then run
  `iscale listing screen <file.json>` (or `iscale check` per field) and rewrite anything
  that comes back risk/unverified. Present the final copy + the check results.
- **Opt-in only - the extension's pipeline in the CLI:** `iscale listing generate design.png --engine codex --json`
  runs the extension's exact pipeline (keywords → Amazon autosuggest validation →
  listing → trademark check + automatic rewrite) on the user's ChatGPT plan (Codex SDK).
  Use it only when the user explicitly asks for the extension's engine; it needs `codex login`.
  `trademark.status` must be `clear` before you call it done.
- **Design sidecars:** both modes look for the image's sidecar by **exact name** in the same
  folder (`design.png` -> `design.json` or `design.png.json`; no other JSON is used), in any format. If it
  describes the design (objects/characters/scene) and says what text is on it (or that
  there is none), it is used and the image is not re-read; otherwise the image is read.
  The output's `designInfo` says which happened. `--read-image` forces reading the image.
- **Saved with the design:** `generate` writes the whole result (every field, keywords,
  tags, trademark result) into the design's JSON under `iscale_listings` (other fields
  untouched). With no sidecar nothing is created (`savedTo` is null; use `--out`).
  `savedTo` says where; `--no-save` skips it. **Tags = the keywords, best first**: a site that takes 13
  tags takes the first 13. Keywords containing a mark the listing check removed are dropped.
- Screen an existing listing or POD sidecar JSON: `iscale listing screen asset.json`.
- Check whether the writer follows the user's prompt (lengths, Brand vs Title, repeats,
  keywords used): `skills/listing-quality-test/SKILL.md` + `node scripts/grade-listing.mjs listing.json`.

## 3. Protect a whole shop

```bash
iscale listings import ~/Downloads/EtsyListingsDownload.csv --class 025   # Etsy: Shop Manager → Settings → Options → Download Data (check Etsy Help if the menu moved)
iscale listings scan --include-description --json --out shop-risk-report.json  # private title/tags/description report; exit 2 = new alerts
iscale alerts --json               # open alerts; --ack <key|listing-id|all> once handled
```

A listing that was fine last month can match a mark registered this week; that is
exactly what `scan` catches. When there are alerts, show the listing, the mark, its
owner/status/filing date, and suggest a rewrite of the title/tags — then re-check it.
Hosted Actions refresh the database only; they cannot read the local shop store. A separately verified local scanner or refresh-and-scan wrapper rechecks the shop after a successful update/freshness gate. See `iscale setup guide schedule`.

**Amazon Merch sellers: get the whole catalog first** (Merch has no export button).
Follow `docs/setup/merch-catalog.md` (`iscale setup guide merch-catalog`):
`iscale merch login` (the user signs in once in a separate Chrome window), then
`iscale merch export` (every listing, all statuses and marketplaces; if it stops, run it
again and it continues), then
`iscale listings import ~/.iscale-listings/merch-export/merch-catalog-live.csv`.

## 4. Set the user up (guided, resumable)

For a fresh own-PC install first read `docs/setup/prerequisites.md`, then follow
`docs/setup/local-walkthrough.md` in order (`iscale setup guide local-walkthrough`).
That guide owns prerequisite/account/schema/import/key/client/scheduler/recovery
order; the checklist is a progress reporter and is not a substitute for it.

Choose `iscale setup workflow cli|extension-subscription|extension-api`, then start with `iscale setup --json` and do the applicable automated `next` step. Once these are complete, follow `nextAcceptance` for external proof/manual reviews; a reported review is not independently verified execution. Walk the user through
one step at a time; do everything that doesn't require them personally.

1. **Profile** — ask for name, email, country, and whether they apply as a person or a
   company; save with `iscale setup profile …`. This fills every office email.
2. **Database** — explain the routes in plain words and let them pick:
   - `supabase`: their own hosted Supabase project (choose storage/billing to fit measured data;
     works with GitHub Actions for automatic updates);
   - `local`: Docker on their computer (free; the computer must be on for updates).
   - `postgres`: native PostgreSQL on Windows; use `docs/setup/database-postgres.md` and require its separate clean-install acceptance.
   Then `iscale setup database <choice>` and follow `iscale setup guide database`.
3. **USPTO** — `iscale setup guide uspto`. The user must create the USPTO.gov account
   and API key themselves (identity verification). Then `iscale setup guide uspto-import`.
4. **EUIPO** — `iscale setup guide euipo`. Generate the documents email with
   `iscale setup letters euipo`, tell the user exactly which documents to attach, and
   after they send it record `iscale setup access euipo requested --note "sent <date>"`.
   When the user pastes a reply, read it, explain it simply, draft the answer, and
   update the state. `iscale setup` flags follow-ups that are due
   (`iscale setup letters euipo --followup`).
5. **Schedule** — `iscale setup guide schedule`; `iscale setup scheduled` reports configuration only. Verify a natural trigger and fresh run receipt; do not report a manual invocation as unattended execution.
6. **Applicable extension + AI** — `iscale setup guide extension`; prove a real browser check/writing flow. Subscription AI uses the helper; OpenAI writing needs no subscription, but a fresh private API install still uses the trusted helper key bridge. The CLI agent workflow needs neither.
7. **Private auth, listing/shop and recovery** — follow `api-auth`, `listings`, `backups` and `acceptance` guides. Use `iscale setup health --json`; 401/404 or missing/stale requested coverage is not ready. Record a reviewed private dossier with `iscale setup review <topic> <file>` (hash stored, still reported/manual, not verified).

Offices change their websites; open the official page linked in each guide/letter and
confirm before telling the user a step is required.

## Troubleshooting

| Symptom | Do |
|---|---|
| Everything is UNVERIFIED, reason mentions EUIPO/US or stale | Data refresh failed. Check the scheduled job (GitHub Actions billing/secrets, or the local task) and re-run the update. |
| `iScale helper … unreachable` | `iscale helper --install` (starts at login), or run `iscale helper`. |
| "not signed in" (extension subscription helper only) | `codex login` (choose "Sign in with ChatGPT"). For CLI listings just use `--agent`. |
| "model is not available on your account" | Clear the model field in extension settings (use the app default) or pick another. |
| Extension shows "helper not running" | Same as above; settings still save in Chrome and sync when the helper starts. |

## Extension registry controls

The Trademark and Keywords tabs show the same Registries buttons: US + EU, US only and EU only. They share the saved selection for page scans, keyword pills and generated-listing checks. Before comparing an extension result with a CLI result, verify the requested registries and classes on both sides; a US mark will not appear in an EU-only check.
