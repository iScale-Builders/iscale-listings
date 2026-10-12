# Private API authentication

Set up your own database and schema first. Keep the API on loopback or your private
network; never point the extension at someone else's private API.

1. In your private `.env.local`, set `TM_DB_URL` (import/admin connection), and either
   `DATABASE_URL` (native PostgreSQL API) or the Supabase URL/service role settings.
2. Register a personal key, without printing it:

   ```bash
   node --env-file=.env.local scripts/create-local-api-key.mjs
   ```

   This writes/reuses `~/.iscale-listings/trademark-api-key` and stores only its SHA-256
   hash in your `api_keys` table. It never overwrites an existing key. Protect the file
   with your OS account permissions; never sync, commit, export or paste it in chat.
   `ISCALE_HOME` selects a separate home for isolated testing. Registration requires
   your own database/admin permissions; it does not create accounts.
3. Set `REQUIRE_API_KEY=true` and `ENABLE_MULTI_JURISDICTION_DB=true`. Set
   `ALLOWED_ORIGINS` to your own browser origins and unpacked extension ID. Restart
   your API after changing environment settings.
4. `npm run build` then `npm start` serves the default `http://localhost:3000`.
   For the CLI, `iscale check "example phrase" --api http://localhost:3000 --json`
   uses the machine-local key. `TRADEMARK_API_KEY` in the process environment overrides
   that file. The helper hands the same machine-local key only to trusted extensions.
5. Set the extension's Trademark API URL to your own URL. Start `iscale helper` and
   follow the extension guide to trust its unpacked ID. Never paste the API key into
   an issue. `iscale setup --api http://localhost:3000 --json` must receive HTTP 200
   with the real v1 connected-database health shape. 401, 404, malformed responses,
   stale/empty registry data and network failures are not setup completion.

A health probe before the first import may report a stale/empty mirror. Follow the
import guides, then recheck. A protected API must reject a no-key request and accept
your valid-key request; verify both on your isolated setup. Do not disable private
mode just to turn an error into green.
