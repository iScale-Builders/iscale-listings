# European Union (EUIPO): get API access

EU trade marks come from the EUIPO API Portal. Access is free but **production access
is approved by EUIPO after you send identity documents by email.** Your agent writes
that email and the follow-ups; you supply your details, attach the documents, and
send it (or approve the agent sending it from your mailbox).

Always glance at the official page first — offices change their process:
<https://dev.euipo.europa.eu/getting-started>

## Steps

1. **Your details (once):**
   `iscale setup profile --name "…" --email "…" --country "…" --subscriber-type "natural person"`
   (use `"legal person"` plus `--legal-entity "…"` if you apply as a company).
2. **Create an EUIPO account** at <https://euipo.europa.eu> (Login → Register).
3. **In the API Portal** (<https://dev.euipo.europa.eu>): open **Apps**, register an
   app, and subscribe it to the **Trademark search** product.
   Save the Client ID and Client Secret from app registration privately now. They are credentials, not proof of production approval. Complete successful Sandbox integration testing before applying for production; use the official [FAQ](https://dev.euipo.europa.eu/faq) and [security guide](https://dev.euipo.europa.eu/security). Never import Sandbox data into the production trademark mirror.
   `iscale setup access euipo account_created`
4. **Documents email:** `iscale setup letters euipo` writes the email, the recipient,
   and the exact attachment list for your subscriber type. Attach the documents, send
   it, then: `iscale setup access euipo requested --note "sent <date>"`
5. **Waiting:** `iscale setup` shows when a follow-up is due (7 days).
   `iscale setup letters euipo --followup` writes it. Paste any reply you get to your
   agent — it will tell you exactly what to do next.
6. **Approved:** verify that your production subscription was approved (separate from app credentials), and save/confirm the **Client ID** and **Client Secret** in
   `.env.local` as `EUIPO_CLIENT_ID` / `EUIPO_CLIENT_SECRET` — **not into a chat** —
   then `iscale setup access euipo credentials_saved`.

The API is rate-limited; the importer is built to respect that. Don't use it as a
per-listing live lookup — the point is your own local copy.

Next: `iscale setup guide euipo-import`.

Approval is assessed after EUIPO receives the required documents; timing is not guaranteed. Quotas follow the subscribed plan, so do not assume a universal rate limit. Production access, saved credentials and an actual completed import are separate states. Product: [Trademark Search](https://dev.euipo.europa.eu/product/trademark-search_100).
