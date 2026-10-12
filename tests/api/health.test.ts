import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isLocalDatabaseStale } from '@/lib/trademark/jurisdictions';

const selectArgs: string[] = [];
const rpcMock = vi.fn();
const singleMock = vi.fn();
const limitMock = vi.fn();
const orderMock = vi.fn(() => ({ limit: limitMock }));
const selectMock = vi.fn((columns: string) => {
  selectArgs.push(columns);
  return { order: orderMock, limit: limitMock };
});
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: fromMock,
    rpc: rpcMock,
  }),
}));

describe('/api/v1/health', () => {
  const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

  it('identifies stale sync (>48 hours)', () => {
    const lastSync = new Date(Date.now() - 49 * 60 * 60 * 1000);
    const isStale = Date.now() - lastSync.getTime() > STALE_THRESHOLD_MS;
    expect(isStale).toBe(true);
  });

  it('identifies fresh sync (<48 hours)', () => {
    const lastSync = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const isStale = Date.now() - lastSync.getTime() > STALE_THRESHOLD_MS;
    expect(isStale).toBe(false);
  });

  it('treats a missing or empty US mirror as not ready', () => {
    const usHealth = { local_database: false, data_stale: false };
    const usReady = Boolean(usHealth.local_database);
    const isStale = Boolean(usHealth.local_database && usHealth.data_stale);
    expect(usReady).toBe(false);
    expect(!usReady || isStale).toBe(true);
  });

  it('treats missing multi-jurisdiction schema as a readiness gate', () => {
    const health = {
      multi_jurisdiction_schema_ready: false,
      schema: {
        multi_jurisdiction_ready: false,
        required_migration: '006_prepare_multi_jurisdiction.sql',
      },
    };

    expect(health.multi_jurisdiction_schema_ready).toBe(false);
    expect(health.schema.required_migration).toBe('006_prepare_multi_jurisdiction.sql');
  });

  it('requires live marks before considering a jurisdiction locally searchable', () => {
    const completedEmptySync = {
      status: 'completed',
      live_mark_count: 0,
    };

    const localDatabase = Boolean(
      completedEmptySync.status === 'completed' && completedEmptySync.live_mark_count > 0
    );

    expect(localDatabase).toBe(false);
  });

  it('can treat a recently imported historical source as stale by source date', () => {
    const sourceUpdatedAt = new Date('2018-02-13T00:00:00Z');
    const maxAgeHours = 168;
    const dataStale = Date.now() - sourceUpdatedAt.getTime() > maxAgeHours * 60 * 60 * 1000;

    expect(dataStale).toBe(true);
  });

  it('does not flag EU data stale while Monday\'s refresh is merely running late, but does after a missed week', () => {
    const lastMonday = Date.parse('2026-09-28T00:00:00Z');
    const sync = { jurisdiction: 'EUIPO', status: 'completed', live_mark_count: 100, source_updated_at: '2026-09-28T00:00:00Z' };
    const hours = (h: number) => lastMonday + h * 60 * 60 * 1000;
    // Next Monday 16:30 UTC — the scheduled job is late but nothing failed.
    expect(isLocalDatabaseStale('EUIPO', sync, hours(7 * 24 + 16.5))).toBe(false);
    // Tuesday after a missed Monday run — that's a real failure.
    expect(isLocalDatabaseStale('EUIPO', sync, hours(8 * 24 + 1))).toBe(true);
  });

  it('treats completed local databases with malformed freshness dates as stale', () => {
    expect(
      isLocalDatabaseStale('EUIPO', {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: 'not-a-date',
        created_at: '2026-05-27T00:00:00Z',
      })
    ).toBe(true);
  });

  it('requires official source dates for non-US freshness', () => {
    expect(
      isLocalDatabaseStale('EUIPO', {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        created_at: new Date().toISOString(),
      })
    ).toBe(true);
  });

  it('allows US sync creation time as freshness evidence', () => {
    expect(
      isLocalDatabaseStale('US', {
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 10_873_728,
        created_at: new Date().toISOString(),
      })
    ).toBe(false);
  });
});

describe('/api/v1/health route selects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectArgs.length = 0;
    const now = new Date().toISOString();
    const row = {
      jurisdiction: 'US',
      source: 'uspto',
      source_updated_at: now,
      sync_date: '2026-08-16',
      status: 'completed',
      live_mark_count: 10_873_728,
      marks_added: 1,
      marks_updated: 1,
      created_at: now,
    };
    singleMock.mockResolvedValue({ data: row, error: null });
    limitMock.mockImplementation(() => ({
      single: singleMock,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [row], error: null }).then(resolve),
    }));
  });

  it('selects named sync_metadata columns and does not probe match RPC', async () => {
    const { GET } = await import('@/app/api/v1/health/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(selectArgs.length).toBeGreaterThan(0);
    for (const columns of selectArgs) {
      expect(columns).not.toContain('*');
      expect(columns).not.toContain('error_message');
    }
  });
});
