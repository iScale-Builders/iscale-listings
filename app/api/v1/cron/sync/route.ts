import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createErrorResponse, ErrorCodes } from '@/lib/errors';
import { createServiceClient } from '@/lib/supabase/server';

/** Constant-time comparison of the Authorization header against the expected
 *  `Bearer <secret>`, so the cron secret can't be recovered via a timing
 *  side-channel on the string compare. */
function cronSecretMatches(authHeader: string | null, expectedSecret: string): boolean {
  if (!authHeader) return false;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(`Bearer ${expectedSecret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daily sync endpoint triggered by Vercel Cron Job.
 * Verifies VERCEL_CRON_SECRET before processing.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  const expectedSecret = process.env.VERCEL_CRON_SECRET;

  if (!expectedSecret || !cronSecretMatches(authHeader, expectedSecret)) {
    return createErrorResponse(
      ErrorCodes.UNAUTHORIZED,
      'Invalid cron secret.'
    );
  }

  // Fail fast if service role key is not configured — a missing key causes
  // the count query to return 0 rows (wrong/placeholder client), which
  // triggers a false safety-check abort recorded as HTTP 200. Better to
  // fail loudly so Vercel marks the cron run as an error.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { status: 'failed', error: 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set' },
      { status: 500 }
    );
  }

  const supabase = createServiceClient();
  const syncStart = Date.now();

  try {
    // Count current LIVE marks for observability, but do not record a completed
    // sync from this endpoint. The real data pipeline runs through
    // scripts/sync_daily_delta.py in GitHub Actions.
    const { count: currentCount, error: countError } = await supabase
      .from('trademarks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'LIVE');

    if (countError) {
      throw new Error(`Failed to count LIVE marks: ${countError.message}`);
    }

    const liveCount = currentCount ?? 0;

    return NextResponse.json({
      status: 'not_configured',
      error: 'Vercel cron sync is disabled; use GitHub Actions daily-sync workflow.',
      live_mark_count: liveCount,
      duration_seconds: Math.round((Date.now() - syncStart) / 1000),
    }, { status: 501 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    // Record failed sync
    await supabase
      .from('sync_metadata')
      .insert({
        sync_date: new Date().toISOString().split('T')[0],
        live_mark_count: 0,
        status: 'failed',
        sync_duration_seconds: Math.round((Date.now() - syncStart) / 1000),
        error_message: errMsg,
      })
      .then(undefined, (err) => console.error('Failed to record sync failure:', err));

    console.error('Sync error:', error);
    return NextResponse.json(
      { status: 'failed', error: errMsg },
      { status: 500 }
    );
  }
}
