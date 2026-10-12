# Download your whole Amazon Merch catalog

Merch on Demand has no "export everything" button. This gets every listing on your
account (every status, every marketplace) into a spreadsheet, then protects it with
trademark monitoring. You only need this repo, Google Chrome and your Merch sign-in.

## For the AI agent running this

Run these for the user, in order. Only step 1 needs the person.

```bash
iscale merch login      # opens a separate Chrome window; the USER signs in (email, password, 2-step code)
iscale merch export     # downloads every listing; prints progress; safe to stop and re-run
iscale merch status     # where an export is (use this after any interruption)
iscale listings import ~/.iscale-listings/merch-export/merch-catalog-live.csv
iscale listings scan    # trademark check of every imported title and brand as separate fields (exit 2 = new alerts)
```

1. **Sign in (the person).** `iscale merch login` opens its own Chrome window with its own
   profile. It is never the user's everyday browser. Tell the user to sign in to
   merch.amazon.com there, including the 2-step code; Amazon may ask for extra
   verification the first time. The command finishes by itself once Merch shows the
   account (it waits up to 15 minutes). Never ask for, type or store the password.
   The sign-in is remembered for next time.
2. **Export.** `iscale merch export` finds the account by itself and downloads every
   listing, 499 per page, with gentle pacing. A few thousand listings take a few minutes;
   very large accounts take hours. It shows `page N: X listings of ~Y (Z%)`.
3. **If it stops for any reason** (crash, closed laptop, network, Ctrl+C), run
   `iscale merch export` again. It continues from the last saved page; at most one page
   is fetched twice and duplicates are removed. Temporary Amazon errors (429/5xx) are
   retried automatically. If the sign-in expired it says so: run `iscale merch login`,
   then `iscale merch export` again; nothing is lost. `--restart` starts over from scratch.
   **Refreshing:** once an export has finished, running `iscale merch export` again downloads a
   fresh copy (the previous files stay until the new one completes).
4. **Results** are in `~/.iscale-listings/merch-export/`:
   - `merch-catalog.csv` / `merch-catalog.json`: every listing, with columns asin, marketplace,
     status, productType, title, brand, listPrice, currencyCode, designId, listingId,
     createdDate, updatedDate, deleteReasonType, lockReasonType, searchableOnRetail.
   - `merch-catalog-live.csv`: published listings, one row per title + brand, ready for
     `iscale listings import`.
5. **Protect it.** Import the live file and run `iscale listings scan --json --out merch-risk-report.json`. Title and Brand are screened separately; the export has no bullets/descriptions. A verified local refresh-and-scan job can recheck this local catalog after a successful update. Hosted Actions update the database only and cannot read your local listing store; schedule the local scanner separately (`iscale setup guide schedule`).

Useful questions to answer from the CSV for the user: how many listings per status and
marketplace, duplicate titles, listings Amazon deleted or rejected (`deleteReasonType`),
and which titles `iscale listings scan` flags.

## Good to know

- **Read-only.** It only reads listings; it never changes anything on the account.
- **Unofficial.** It reads the same internal service the Merch website uses for its
  product list. It is not a public Amazon API, so Amazon can change it at any time; if
  the export starts failing on every page, the repo needs an update.
- **Your account only**, with your own sign-in. The sign-in stays in
  `~/.iscale-listings/merch-browser/` on this computer. Delete that folder to sign out.
- **Bullets and descriptions are not included**: the product list does not contain them.
