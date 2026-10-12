# EUIPO Source Module

EUIPO is the first European source to document for open-source users, but setup
is more account/portal dependent than USPTO. Treat this as a user-owned source
access workflow.

## User-Owned Requirements

The user needs one of:

- EUIPO API Portal credentials with access to Trademark Search; or
- an official EUIPO delivery/export path supported by the import tools.

They also need their own database and secret storage. Do not ship
EUIPO credentials or imported rows.

## Agent Bootstrap Flow

1. Confirm the database is schema-ready.
2. Ask whether the user has API credentials or a delivery file.
3. If using API credentials, set:

```bash
EUIPO_CLIENT_ID=
EUIPO_CLIENT_SECRET=
EUIPO_ACCESS_VERIFIED_AT=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

4. Run a credentialed probe before importing.
5. Run a tiny dry run.
6. Run a full source-dated import.
7. Record sync metadata.
8. Run readiness/health checks.

## Current Repo Commands To Evaluate

```bash
npm run probe:euipo-search
npm run import:euipo -- --since <yyyy-mm-dd> --classes 9,16,18,20,21,24,25 --partition-statuses --source-updated-at <official-date>
curl http://localhost:3000/api/v1/health   # EUIPO row should be fresh
```

For real writes, do not use page-limited imports as if they were complete local
coverage. Page limits are for dry runs and debugging.

## Freshness Principle

EUIPO freshness should use the official source/update date when available, not
only the time the local import job finished.

## Agent Warnings

- EUIPO portal/API rules may change; verify current official docs before setup.
- Do not print client secrets or access tokens.
- Do not mix EUIPO coverage with national trademark office coverage. EUIPO is EU
  trade marks; it is not a replacement for every national source.
- The current full setup/checklist and health gate require both US and EUIPO.
  A US-only query is scoped screening, not accepted US+EU setup; extension registry
  controls do not waive initial data access/import requirements.


See [official government data terms](../data-terms.md): government data is not MIT-licensed.
