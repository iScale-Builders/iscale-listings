import { NextRequest, NextResponse } from 'next/server';
import { CheckRequestSchema } from '@/lib/validation/schemas';
import { matchTrademarks, CandidateOverflowError } from '@/lib/trademark/matcher';
import { normalizeText } from '@/lib/trademark/normalize';
import { MAX_REQUEST_RESULTS } from '@/lib/trademark/constants';
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

export async function POST(request: NextRequest) {
  try {
    const json = await readJsonBody(request);
    if (!json.ok) return json.response;

    // Validate request
    const parsed = CheckRequestSchema.safeParse(json.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      const code = firstError.path.includes('text')
        ? ErrorCodes.INVALID_TEXT_LENGTH
        : firstError.path.includes('classes')
          ? ErrorCodes.INVALID_CLASS
          : ErrorCodes.INVALID_PARAM;
      return createErrorResponse(code, firstError.message);
    }

    const { text, classes, include_dead, jurisdictions, max_results } = parsed.data;

    // Validate text content: must have at least one word >= 3 chars
    const normalized = normalizeText(text);
    const words = normalized.split(' ').filter((w) => w.length > 1);
    const hasValidWord = words.some((w) => w.length >= 3);
    if (!hasValidWord) {
      return createErrorResponse(
        ErrorCodes.INVALID_TEXT_CONTENT,
        'Text must contain at least one alphanumeric word with 3 or more characters.'
      );
    }

    const multiJurisdictionEnabled = process.env.ENABLE_MULTI_JURISDICTION_DB === 'true';
    const supabase = createServiceClient();
    const { data: recentSyncs, error: syncError } = await supabase
      .from('sync_metadata')
      .select('jurisdiction,status,live_mark_count,created_at,source_updated_at')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(100);
    if (syncError) {
      // A DB failure here must surface as "couldn't check" — never a silent empty/clear result.
      console.error('sync_metadata read failed:', syncError);
      return createErrorResponse(
        ErrorCodes.DB_UNAVAILABLE,
        'Trademark database is unavailable — your text was NOT checked. Please try again shortly.'
      );
    }
    const dbJurisdictions = getDatabaseJurisdictions(
      jurisdictions,
      multiJurisdictionEnabled,
      recentSyncs ?? []
    );
    const officialLookupJurisdictions = getOfficialLookupJurisdictions(
      jurisdictions,
      dbJurisdictions
    );
    const officialLookupActions = buildOfficialLookupActions(text, officialLookupJurisdictions);
    const shouldCheckDatabase = dbJurisdictions.length > 0;

    // Freshness: flag if any checked jurisdiction's local data is NOT fresh —
    // i.e. stale OR missing/empty (never synced, zero live marks). Keying on
    // "not fresh" instead of "stale" closes a fail-open hole: an empty or
    // never-synced DB has no stale row, so `isLocalDatabaseStale` returned
    // false and the response was a confident green "clear" on everything. Now
    // the client shows "results may be incomplete" instead.
    const latestByJurisdiction = latestSyncByJurisdiction(recentSyncs ?? []);
    // A requested jurisdiction that was not searched locally means the screen
    // did not happen for it. Fold that into data_stale too, so clients that only
    // read data_stale (older extensions/SDKs) show "unverified" instead of clear.
    const coverageComplete = officialLookupJurisdictions.length === 0;
    const dataStale =
      !coverageComplete ||
      dbJurisdictions.some((j) => !isFreshLocalDatabase(j, latestByJurisdiction.get(j)));

    // Run matching pipeline for the local USPTO mirror. Other jurisdictions expose official lookups
    // until their official data has been imported into the multi-jurisdiction table.
    const result = shouldCheckDatabase && supabase
      ? await matchTrademarks(text, classes, supabase, include_dead, dbJurisdictions, max_results)
      : { matches: [], totalMatches: 0, truncated: false, queryTimeMs: 0 };

    // Log to check_history (fire and forget). Anonymous /check stays public;
    // do not retain unauthenticated input_text.
    const userId = request.headers.get('x-auth-user-id');
    const apiKeyId = request.headers.get('x-auth-api-key-id');
    const source = request.headers.get('x-auth-source');
    if (supabase && source === 'api_key') {
      supabase
      .from('check_history')
      .insert({
        user_id: userId || null,
        api_key_id: apiKeyId ? Number(apiKeyId) : null,
        input_text: text.slice(0, 2000),
        classes_checked: classes.join(','),
        match_count: result.totalMatches,
        query_time_ms: result.queryTimeMs,
      })
      .then(undefined, (err) => console.error('Failed to write check_history:', err));
    }

    return NextResponse.json({
      matches: result.matches,
      total_matches: result.totalMatches,
      truncated: result.truncated,
      result_limit: max_results,
      result_limit_max: MAX_REQUEST_RESULTS,
      query_time_ms: result.queryTimeMs,
      text_length: text.length,
      data_last_synced: latestSyncTimestampForJurisdictions(recentSyncs ?? [], dbJurisdictions),
      data_stale: dataStale,
      jurisdictions_requested: jurisdictions,
      jurisdictions_checked: dbJurisdictions,
      jurisdictions_unchecked: officialLookupJurisdictions,
      coverage_complete: coverageComplete,
      official_lookup_actions: officialLookupActions,
    });
  } catch (error) {
    if (error instanceof CandidateOverflowError) {
      return createErrorResponse(
        ErrorCodes.CANDIDATE_OVERFLOW,
        error.message
      );
    }

    if (
      error instanceof Error &&
      error.message?.includes('statement timeout')
    ) {
      return createErrorResponse(
        ErrorCodes.QUERY_TIMEOUT,
        'Query took too long. Try checking a shorter section of text.'
      );
    }

    // Supabase / PostgREST errors carry a string `code`. A DB failure must be
    // reported as unavailable (503), not a generic 500 the SDK silently retries
    // — otherwise "couldn't check" looks like "no conflicts found".
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
    ) {
      console.error('Check DB error:', error);
      return createErrorResponse(
        ErrorCodes.DB_UNAVAILABLE,
        'Trademark database is unavailable — your text was NOT checked. Please try again shortly.'
      );
    }

    console.error('Check error:', error);
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'An unexpected error occurred.'
    );
  }
}
