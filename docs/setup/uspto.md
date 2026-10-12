# United States (USPTO): get your data key

US trademark data is free from the USPTO Open Data Portal, but you need **your own
account and API key**.

## What only you can do

- Create or sign in to a **USPTO.gov account** at <https://data.uspto.gov>. The USPTO
  requires USPTO.gov multifactor authentication and a completed ODP profile. Follow
  the current portal flow for ID.me/MyUSPTO identity verification and linking where
  required. An AI agent cannot complete your identity check or account codes.
- Create an **API key** in the portal (your profile / API key page).

## What your agent does

1. Fills in your details once: `iscale setup profile --name "…" --email "…" --country "…" --subscriber-type "natural person"`.
2. Writes a ready-to-send support email if the portal gives you trouble:
   `iscale setup letters uspto` (saved under `~/.iscale-listings/letters/`).
3. Tracks progress: `iscale setup access uspto account_created` → `credentials_saved`.

## Save the key

Put it in `.env.local` as `USPTO_API_KEY=…` — **not into a chat**. Then:

```bash
iscale setup access uspto credentials_saved
iscale setup
```

Next: `iscale setup guide uspto-import`.

Official prerequisites: [USPTO identity notice](https://content.govdelivery.com/accounts/USPTO/bulletins/3cc68ff), [ODP profile/access notice](https://content.govdelivery.com/accounts/USPTO/bulletins/41fc955), and [API authentication examples](https://data.uspto.gov/apis/api-syntax-examples). Verify the current portal requirements when you apply; an account/key configured locally does not prove the importer ran.
