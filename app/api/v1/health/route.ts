import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { createErrorResponse, ErrorCodes } from '@/lib/errors';
import { FRESHNESS_HOURS_BY_JURISDICTION, JURISDICTIONS } from '@/lib/trademark/constants';
import {
  isLocalDatabaseStale,
  latestSyncByJurisdiction,
  type SyncMetadataHealthRow,
} from '@/lib/trademark/jurisdictions';

interface SyncMetadataRow extends SyncMetadataHealthRow {
  jurisdiction?: string | null;
  source?: string | null;
  sync_date?: string | null;
  live_mark_count?: number | null;
  marks_added?: number | null;
  marks_updated?: number | null;
  status?: string | null;
  created_at?: string | null;
  source_updated_at?: string | null;
}

async function hasMultiJurisdictionSchema(
  supabase: ReturnType<typeof createServiceClient>
): Promise<boolean> {
  const { error } = await supabase.from('sync_metadata').select('jurisdiction').limit(1);
  return !error;
}

export async function GET() {
  try {
    const supabase = createServiceClient();

    // Check DB connectivity + get latest sync
    const { data: syncData, error: syncError } = await supabase
      .from('sync_metadata')
      .select('jurisdiction,source,source_updated_at,sync_date,status,live_mark_count,marks_added,marks_updated,created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (syncError && syncError.code !== 'PGRST116') {
      // PGRST116 = no rows, which is OK for fresh install
      return createErrorResponse(
        ErrorCodes.DB_UNAVAILABLE,
        'Database connection failed.'
      );
    }

    const { data: recentSyncs } = await supabase
      .from('sync_metadata')
      .select('jurisdiction,status,live_mark_count,created_at,source_updated_at,source,sync_date')
      .order('created_at', { ascending: false })
      .limit(100);

    const latestByJurisdiction = latestSyncByJurisdiction(recentSyncs ?? []);

    const multiJurisdictionSchemaReady = await hasMultiJurisdictionSchema(supabase);

    const jurisdictions = JURISDICTIONS.map((jurisdiction) => {
      const sync = latestByJurisdiction.get(jurisdiction);
      const maxAgeHours = FRESHNESS_HOURS_BY_JURISDICTION[jurisdiction] ?? 168;
      const liveMarkCount = sync?.live_mark_count ?? 0;
      const localDatabase = Boolean(
        sync && sync.status === 'completed' && liveMarkCount > 0
      );
      const dataStale = isLocalDatabaseStale(jurisdiction, sync);

      return {
        jurisdiction,
        status: sync ? sync.status : 'not_configured',
        source: sync?.source ?? (jurisdiction === 'US' ? 'uspto' : null),
        last_synced_at: sync?.created_at ?? null,
        source_updated_at: sync?.source_updated_at ?? null,
        sync_date: sync?.sync_date ?? null,
        live_mark_count: liveMarkCount,
        data_stale: dataStale,
        freshness_max_age_hours: maxAgeHours,
        local_database: localDatabase,
      };
    });

    const usHealth = jurisdictions.find((item) => item.jurisdiction === 'US');
    const isStale = Boolean(usHealth?.local_database && usHealth.data_stale);
    const usReady = Boolean(usHealth?.local_database);

    if (!usReady || isStale) {
      return createErrorResponse(
        ErrorCodes.SYNC_STALE,
        usReady
          ? 'USPTO data is stale. Last successful sync was more than 48 hours ago.'
          : 'USPTO local mirror is empty or has never completed a sync.'
      );
    }

    return NextResponse.json({
      status: 'ok',
      version: 'v1',
      database: 'connected',
      last_sync: syncData
        ? {
            jurisdiction: syncData.jurisdiction ?? 'US',
            source: syncData.source ?? 'uspto',
            source_updated_at: syncData.source_updated_at ?? null,
            date: syncData.sync_date,
            status: syncData.status,
            live_mark_count: syncData.live_mark_count,
            marks_added: syncData.marks_added,
            marks_updated: syncData.marks_updated,
        }
        : null,
      jurisdictions,
      multi_jurisdiction_schema_ready: multiJurisdictionSchemaReady,
      schema: {
        multi_jurisdiction_ready: multiJurisdictionSchemaReady,
        required_migration: '006_prepare_multi_jurisdiction.sql',
      },
      data_stale: isStale,
    });
  } catch (error) {
    console.error('Health check error:', error);
    return createErrorResponse(
      ErrorCodes.DB_UNAVAILABLE,
      'Health check failed.'
    );
  }
}
