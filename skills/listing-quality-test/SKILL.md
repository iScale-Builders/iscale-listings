---
name: listing-quality-test
description: Test whether the AI listing writer follows the user's prompt rules, with numbers instead of eyeballing. Generates a real listing from a design image with the `iscale` CLI (same settings and prompt as the Chrome extension), grades it (field lengths, Brand vs Title overlap, repeated words, keywords used, what the trademark check removed), and reports the full listing plus a rule-by-rule table. Use when the user asks "is it following my prompt?", "test my prompt", "make a listing from this image and check it", or is tuning their prompt preset.
---

# Listing quality test

Answer "did the AI follow my prompt?" with a real run and measured numbers. Never answer
from memory or from an older run.

## 1. Generate a real listing (same settings as the extension)

```bash
# Tests the EXTENSION's writer, so it opts in to the extension's engine explicitly.
# (Normal CLI listings are written by the agent: --agent.)
iscale listing generate "<design.png>" --engine codex --json > listing.json
```

- The CLI reads the user's shared settings (the active prompt preset, field limits,
  banned words, trademark classes) from the local helper's settings file. Make sure the
  helper has the user's current settings (`iscale helper --status`), and run the CLI on the
  machine whose extension the user is tuning.
- Use `node cli/iscale.mjs …` if `iscale` is not linked.
- One run per design. Generation is not deterministic: run 2–3 different designs before
  judging a prompt change.

## 2. Grade it

```bash
node scripts/grade-listing.mjs listing.json
```

It prints PASS/FAIL per check, the keywords used vs offered, and what the trademark check
removed. Exit 0 = all checks pass, 2 = at least one failed.

| Check | Pass when |
|---|---|
| Field length | Title/Brand ≥ 90% of the limit, other fields ≥ 85%, never over |
| Brand vs Title | the Brand shares at most one word with the Title |
| No repeated words | none in Title or Brand (a repeat is fine only inside a different longtail keyword; judge that by hand) |
| Overused words | no word more than twice across the bullet/description fields |
| Keywords used | how many offered keywords made it into the copy (higher is better) |
| Removed by trademark check | words the check took out after writing; they shorten fields |

## 3. Report to the user

1. **The whole listing first**: every field with `chars/limit`, word for word.
2. **A rule-by-rule table** built from the user's own prompt preset (read it from the
   settings, or `iscale listing generate … --agent --json` → `instructions`): each rule,
   followed / not followed, with the number that proves it. Measurable rules use the
   grader; the rest (tone, "design only") are judged by reading the copy.
3. **The cause of each miss**, in plain words, and the one fix that would address it.

## Known causes of misses (check these before blaming the prompt)

- **Too few keywords handed to the AI.** The writer only sees the top `maxKeywords`
  keywords (default 30). With too few it must repeat words to fill the fields.
- **Built-in rules.** The listing prompt adds built-in rules (no commas in Title/Brand,
  forbidden words, keyword casing, no repeated words except in a different longtail).
  The user's rules are placed after them and win on conflict.
- **The trademark check runs after writing.** It removes or replaces flagged phrases
  (often common words that are registered marks for apparel), which can cut a 58-character
  Title to 45. The grader lists what was removed; a short field with a long removal list is
  a trademark effect, not a prompt problem.
- **Quality pass.** After the first draft the writer measures short fields, a Brand that
  copies the Title and overused words, and asks the AI for one revision; it keeps the
  revision only if it has fewer problems. Grade the final output, not the first draft.
