# AI Provider Setup

> **The CLI is run by whichever AI agent is operating it.** `iscale listing generate <image> --agent`
> (the default) hands the writing to that agent - Claude, Codex, Grok, any agent; it writes the
> fields itself, then runs `iscale listing screen <file.json>` / `iscale check`. ChatGPT/Codex
> (e.g. gpt-5.5) is only the Chrome extension's helper engine and is never required for the CLI.

The choices below are for the **Chrome extension**. Pick one in its settings:

| Choice | Cost | Setup |
|---|---|---|
| **Your ChatGPT/Codex subscription** (default) | Included in your plan | `codex login` once; the extension also needs `iscale helper` running |
| **OpenAI API key** | Pay per use | Paste the key in extension settings (stays in Chrome) |

## Your ChatGPT plan (no API key)

This uses OpenAI's official **Codex SDK** (`@openai/codex-sdk`), installed with the repo.
It runs Codex on your own computer with your own ChatGPT sign-in.

```bash
npx codex login        # choose "Sign in with ChatGPT"
iscale ai test         # one short test request
```

- **CLI:** not used by default - the agent running the CLI writes the listing
  (`--agent`). Only an explicit `iscale listing generate design.png --engine codex` runs this
  engine inside the CLI (opt-in, e.g. to test the extension's exact pipeline).
- **Extension:** a browser extension can't start Codex by itself, so it asks the small
  local helper to do it. Run `iscale helper --install` once (it then starts hidden at
  every login; `--status` / `--uninstall`), then in the extension
  choose **⚙ → ChatGPT/Codex subscription (local helper)**. Optionally set a Codex model
  (blank = Codex's default).

How it stays safe:

- Each job is a fresh Codex thread in a throwaway folder, read-only, with network and
  web search off.
- All `*_API_KEY` variables are removed from the Codex process, so a plan run can never
  silently become pay-per-use.
- The helper listens only on `127.0.0.1` and only accepts the extension / localhost.
- **Use your own sign-in only.** Don't share a helper or a ChatGPT login with other
  people — that's against OpenAI's terms. Anything shared, hosted or public must use an
  OpenAI API key instead.
- If the helper or Codex isn't available you get an error — never a silent fallback to
  a paid API.

## OpenAI API key

Choose **⚙ → OpenAI API key** in the extension and paste your key. It is stored only in
Chrome and is never exported, shared with the helper, or sent to the CLI.

## Adding another AI

Engines live in `cli/lib/engines.mjs`. Contributors can add another provider as a new
engine plus a test in `tests/cli/helper.test.ts`; check that provider's terms for
personal-plan use first.
