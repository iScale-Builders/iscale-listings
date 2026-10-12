# First listing and whole-shop screening

## AI agent / CLI

```bash
iscale listing generate design.png --agent --json
```

The operating agent reads the returned writing brief, inspects the image (or its
verified design sidecar), and writes `listing.json` with `fields` (each field has
`id`, `name`, `content`) and `keywords` (strings). The CLI does not call an in-CLI
model. Do not change personal Codex settings or require a ChatGPT plan for this path.

```bash
iscale listing screen listing.json --json --out listing-risk-report.json
```

The report screens fields separately and keywords individually. Exit 0 means no
matches found in the requested coverage, 2 means risk, 3 means unverified. Review
matches, rewrite, and screen again; never publish an unverified result. The CLI
writes only a small local last-screen receipt for setup progress, not your content.
A risk receipt proves screening happened; it does not approve the listing.

## Extension

Build/load the unpacked extension and use your own helper subscription or OpenAI
key as described in [extension](extension.md). Verify the loaded version and the
US/EU registry choice on both tabs. These share one saved scope. Changing scope
does not automatically recheck old results; rerun the check.

## Whole shop

Etsy: Shop Manager → Settings → Options → Download Data. Keep the private CSV outside
the repo. Import reads TITLE, TAGS and DESCRIPTION columns. Amazon Merch: follow
[the catalog guide](merch-catalog.md); its export has title/brand and no bullets. Optional Brand/Brand Name columns are imported and screened as their own field; title, brand and description are never concatenated into a false cross-field phrase. Missing brand on Etsy is unchanged.

```bash
iscale listings import /private/path/EtsyListingsDownload.csv
iscale listings scan --include-description --json --out shop-risk-report.json
iscale alerts --json --out shop-alerts.json
```

Imported brand is always screened when present. Description scanning is explicit: omit `--include-description` only when you intend
title/tags-only coverage. Verify the imported listing count and one known title,
tags and description privately. Reports and `~/.iscale-listings/listings.json`
contain shop content; do not commit them or attach unredacted reports to issues.
Imported listings are not screened until scan completes. Risk findings stay risks;
a scan with no new alerts can still contain existing risk matches. Unverified rows
need a successful retry after repairing data/API access. Exporting a report is not
an upload, account change or automatic rewrite.

## Monitoring

Database refresh and local shop recheck are separate operations. Hosted Actions do
not have this computer's listing store. Run a local scanner after the hosted refresh,
or use the local refresh-and-scan wrapper. See [scheduling](schedule.md).

Coverage gaps are explicit in the JSON report (`incomplete`, `coverageComplete`, `coverageGaps`) and each stored row. Any incomplete/unverified row makes aggregate exit 3 take precedence over new-alert exit 2; known actionable alerts remain present. Complete new risks still exit 2, complete no-new-alert scans exit 0. A failed refresh receipt is not completed coverage.

Import identity: explicit SKU/ID/ASIN fields retain their semantics. Without an ID, normalized title, brand, tags and description determine a stable content hash; distinct same-title contents are retained and exact-content reimports deduplicate. Merch live rows use the title+brand dedup tuple for their stable ID, not a shared design ID. Older stored fallback IDs are not migrated or deleted automatically; review any historical duplicate records privately, and preserve known alerts.
