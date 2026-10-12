# Chrome extension

The extension is the visual side: scan any page (Amazon, Etsy, anything) for
trademark risks, and generate listings with keywords checked against Amazon search
and your trademark database. It works on its own; the CLI is optional.

## Install

```bash
npm ci
npm run build:extension
```

Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
choose the `extension/dist` folder. Pin it and click the icon to open the side panel.
After updating the code, run the build again and press ↻ on the extension card.

## Connect it

Open the **⚙ settings** in the panel:

1. **Trademark API URL** — your own API from the setup (`http://localhost:3000` by
   default, or wherever you deployed it).
2. **AI** — pick one:
   - **ChatGPT/Codex subscription (local helper)** — no API key. Run `npx codex login` once
     ("Sign in with ChatGPT"), then start the helper once so it runs hidden at every
     login — no terminal to keep open:

     ```bash
     iscale helper --install      # iscale helper --status / --uninstall
     ```

     (Or run `iscale helper` in a terminal when you need it.)

   - **OpenAI API key** — pay per use, no helper or Codex sign-in needed **for AI writing**. For a private trademark API, a fresh extension also needs its machine-local trademark key: start `iscale helper`, trust this unpacked extension ID, and let the key bridge transfer it (no Codex login needed for that route). Once Chrome stores the key, the OpenAI writing/check path can work without a running helper. Choose it in
     the AI dropdown, paste the key and pick a model. The key stays in Chrome only.

   This choice is for the extension only. The `iscale` CLI does not use it: the AI agent
   running the CLI writes listings itself (`iscale listing generate <image> --agent`).

## Private trademark key bridge

Follow [api-auth.md](api-auth.md) to register your own machine key. Start `iscale helper` under that same OS user and open the extension. The helper health route and trusted `/trademark-key` delivery do not require an AI subscription/login. Keep the helper on loopback and trust only your own unpacked extension ID. A first successful private trademark check proves delivery; a helper process alone does not. CLI agents read the machine key directly and do not need this bridge. `iscale setup workflow extension-api` still checks the helper bootstrap prerequisite separately from AI-provider login.

## Registry selection

The **Trademark** and **Keywords** tabs both show **US + EU**, **US only** and
**EU only** controls. They use one shared, saved choice for page scans, keyword
screening and listing trademark checks; changing either row updates both.

After changing registries, rerun the scan or trademark check for existing results.
Changing the selection does not automatically recheck already generated results.

## Moving settings between the extension and the CLI

Your prompt rules, presets, fields, trademark classes and banned words can be shared
with the CLI two ways:

- **Export / Import (always works):** ⚙ → Listing settings → **Export settings** saves a
  file; `iscale settings import <file>` loads it into the CLI. The other way:
  `iscale settings export <file>`, then **Import settings** in the extension.
- **Automatic (optional):** with **Share settings with the CLI automatically** on and
  `iscale helper` running, both stay in sync on their own. Turn it off to use Export /
  Import only.

API keys are never included in either.
