import { NextRequest, NextResponse } from 'next/server';
import { BatchRequestSchema } from '@/lib/validation/schemas';
import { matchTrademarks, CandidateOverflowError } from '@/lib/trademark/matcher';
import { MAX_REQUEST_RESULTS } from '@/lib/trademark/constants';
import { normalizeText } from '@/lib/trademark/normalize';
import {
  buildOfficialLookupActions,
  getDatabaseJurisdictions,
  getOfficialLookupJurisdictions,
  isFreshLocalDatabase,
  latestSyncByJurisdiction,
  latestSyncTimestampForJurisdictions,
} from '@/lib/trademark/jurisdictions';
import { createErrorResponse, ErrorCodes, readJsonBody } from '@/lib/errors';
import { createServiceClient } from '@/lib/supabase/server';
import { BATCH_LIMITS } from '@/lib/trademark/constants';
import { parseAuthTier } from '@/lib/auth/types';
import type { BatchResultItem } from '@/lib/trademark/types';

function isSupabaseError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
  );
}

export async function POST(request: NextRequest) {
  try {
    const source = request.headers.get('x-auth-source');
    const tier = parseAuthTier(
      request.headers.get('x-auth-tier'),
      source === 'api_key' ? 'free' : 'anonymous'
    );

    // Anonymous cannot use batch
    if (source !== 'api_key' || tier === 'anonymous') {
      return createErrorResponse(
        ErrorCodes.UNAUTHORIZED,
        'Batch checking requires an API key.'
      );
    }

    const json = await readJsonBody(request);
    if (!json.ok) return json.response;

    // Validate request
    const parsed = BatchRequestSchema.safeParse(json.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      return createErrorResponse(ErrorCodes.INVALID_PARAM, firstError.message);
    }

    const { items } = parsed.data;

    // Check per-tier batch limits
    const maxItems = BATCH_LIMITS[tier];
    if (items.length > maxItems) {
      return createErrorResponse(
        ErrorCodes.BATCH_TOO_LARGE,
        `Your tier allows up to ${maxItems} items per batch. You sent ${items.length}.`
      );
    }

    const supabase = createServiceClient();
    const startTime = performance.now();
    const results: BatchResultItem[] = [];
    const multiJurisdictionEnabled = process.env.ENABLE_MULTI_JURISDICTION_DB === 'true';
    const { data: recentSyncs, error: syncError } = await supabase
      .from('sync_metadata')
      .select('jurisdiction,status,live_mark_count,created_at,source_updated_at')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(100);
    if (syncError) {
      // A DB failure must surface as "couldn't check" — never silent empty/clear results.
      console.error('sync_metadata read failed:', syncError);
      return createErrorResponse(
        ErrorCodes.DB_UNAVAILABLE,
        'Trademark database is unavailable — your batch was NOT checked. Please try again shortly.'
      );
    }
    const latestByJurisdiction = latestSyncByJurisdiction(recentSyncs ?? []);

    // Process each item
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const dbJurisdictions = getDatabaseJurisdictions(
        item.jurisdictions,
        multiJurisdictionEnabled,
        recentSyncs ?? []
      );
      const officialLookupJurisdictions = getOfficialLookupJurisdictions(
        item.jurisdictions,
        dbJurisdictions
      );
      const officialLookupActions = buildOfficialLookupActions(item.text, officialLookupJurisdictions);
      const shouldCheckDatabase = dbJurisdictions.length > 0;
      // "Not fresh" (stale OR missing/empty), not just "stale" — so an empty or
      // never-synced DB surfaces as unverified rather than a false green clear.
      // An unsearched requested jurisdiction is also "unverified" (see /check).
      const coverage = {
        jurisdictions_unchecked: officialLookupJurisdictions,
        coverage_complete: officialLookupJurisdictions.length === 0,
      };
      const itemDataStale =
        !coverage.coverage_complete ||
        dbJurisdictions.some((j) => !isFreshLocalDatabase(j, latestByJurisdiction.get(j)));
      // Same content gate as /check: an item with no word >= 3 chars generates
      // zero candidates and would return 0 matches — a silent false "clear".
      // Attach a per-item error instead so "not screenable" never reads as
      // "no conflicts".
      const itemHasValidWord = normalizeText(item.text)
        .split(' ')
        .filter((w) => w.length > 1)
        .some((w) => w.length >= 3);
      if (!itemHasValidWord) {
        results.push({
          index: i,
          matches: [],
          total_matches: 0,
          truncated: false,
          query_time_ms: 0,
          jurisdictions_requested: item.jurisdictions,
          jurisdictions_checked: dbJurisdictions,
          ...coverage,
          official_lookup_actions: officialLookupActions,
          data_stale: itemDataStale,
          error: {
            code: ErrorCodes.INVALID_TEXT_CONTENT,
            message:
              'Item text must contain at least one alphanumeric word with 3 or more characters.',
          },
        });
        continue;
      }
      try {
        const result = shouldCheckDatabase
          ? await matchTrademarks(item.text, item.classes, supabase, item.include_dead, dbJurisdictions, item.max_results)
          : { matches: [], totalMatches: 0, queryTimeMs: 0, truncated: false };
        results.push({
          index: i,
          matches: result.matches,
          total_matches: result.totalMatches,
          truncated: result.truncated,
          result_limit: item.max_results,
          result_limit_max: MAX_REQUEST_RESULTS,
          query_time_ms: result.queryTimeMs,
          jurisdictions_requested: item.jurisdictions,
          jurisdictions_checked: dbJurisdictions,
          ...coverage,
          official_lookup_actions: officialLookupActions,
          data_stale: itemDataStale,
        });
      } catch (error) {
        if (isSupabaseError(error)) {
          console.error('Batch check DB error:', error);
          return createErrorResponse(
            ErrorCodes.DB_UNAVAILABLE,
            'Trademark database is unavailable — your batch was NOT checked. Please try again shortly.'
          );
        }

        const errorMsg =
          error instanceof CandidateOverflowError
            ? { code: ErrorCodes.CANDIDATE_OVERFLOW, message: error.message }
            : { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to process item' };
        results.push({
          index: i,
          matches: [],
          total_matches: 0,
          truncated: false,
          query_time_ms: 0,
          jurisdictions_requested: item.jurisdictions,
          jurisdictions_checked: dbJurisdictions,
          ...coverage,
          official_lookup_actions: officialLookupActions,
          data_stale: itemDataStale,
          error: errorMsg,
        });
      }
    }

    const totalQueryTimeMs = Math.round(performance.now() - startTime);

    return NextResponse.json({
      results,
      total_query_time_ms: totalQueryTimeMs,
      data_last_synced: latestSyncTimestampForJurisdictions(
        recentSyncs ?? [],
        Array.from(new Set(results.flatMap((result) => result.jurisdictions_checked)))
      ),
    });
  } catch (error) {
    console.error('Batch check error:', error);
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'An unexpected error occurred.'
    );
  }
}
