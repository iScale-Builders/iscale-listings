# Local Trademark Database Bootstrap

Open-source users need their own database. The code can provide schema,
importers, and checks, but not production data.

## Target Local Stack

Preferred default:

- Postgres with `pg_trgm`.
- Supabase local or hosted Supabase as a convenient Postgres/PostgREST option.
- Service-role style credential kept only in local environment variables or the
  user's own secret store.

The package should also document a plain Postgres path for users who do not
want Supabase-hosted infrastructure.

## Agent Setup Flow

1. Ask the user which database target they want: hosted Supabase, local Supabase,
   or plain Postgres.
2. Create the database outside the repository.
3. Apply migrations in order.
4. Confirm required extensions and RPC functions are present.
5. Import at least one source, usually USPTO first.
6. Run readiness/health checks.
7. Configure recurring sync only after the initial import succeeds.

## Environment Contract

Open-source examples should use placeholder values only:

```bash
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TM_DB_URL=
USPTO_API_KEY=
EUIPO_CLIENT_ID=
EUIPO_CLIENT_SECRET=
EUIPO_ACCESS_VERIFIED_AT=
EUIPO_DELIVERY_PATH=
OPENAI_API_KEY=
```

Do not document private vault paths as the open-source path.

## Verification Commands

Current repo-owned checks to preserve or adapt for open-source users:

```bash
curl http://localhost:3000/api/v1/health      # US + EUIPO rows, data_stale
npm run db:production-monitor -- --base-url http://localhost:3000 --require-env ""
```

For open-source users, `db:production-monitor` should eventually become a local
or self-hosted monitor pointed at their own deployment, not
production.

## Database Completion Levels

Use explicit levels so users are not blocked by countries they do not need:

- `schema-ready`: migrations applied, health endpoint works.
- `us-ready`: USPTO local mirror imported and fresh.
- `euipo-ready`: EUIPO local mirror imported and fresh.
- `selected-market-ready`: only the user's selected jurisdictions are fresh.
- `complete`: all documented jurisdictions are fresh and source access is
  verified.

This avoids making a new user's first setup fail because optional countries are
not configured.
