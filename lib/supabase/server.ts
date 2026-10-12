import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPgClient } from './pg-client';

/**
 * Server-side database client.
 *
 * - `DATABASE_URL` set: plain PostgreSQL (self-hosting without Supabase or
 *   Docker). Same query surface, see ./pg-client.ts.
 * - Otherwise: Supabase with the service role key (bypasses RLS).
 *
 * Use only in API routes and server-side scripts. NEVER expose this client,
 * the database URL or the service role key to the browser.
 */
export function createServiceClient(): SupabaseClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return createPgClient(databaseUrl) as unknown as SupabaseClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'DATABASE_URL (plain PostgreSQL), or NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    );
  }

  return createSupabaseClient(url, key);
}
