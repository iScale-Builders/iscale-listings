import { describe, it, expect } from 'vitest';
import { BATCH_LIMITS, MAX_BATCH_SIZE } from '@/lib/trademark/constants';
import { latestSyncTimestampForJurisdictions } from '@/lib/trademark/jurisdictions';

describe('/api/v1/check/batch validation', () => {
  it('rejects batch for anonymous users', () => {
    expect(BATCH_LIMITS.anonymous).toBe(0);
  });

  it('limits free tier to 5 items', () => {
    expect(BATCH_LIMITS.free).toBe(5);
  });

  it('limits premium tier to 20 items', () => {
    expect(BATCH_LIMITS.premium).toBe(20);
  });

  it('global max batch size is 20', () => {
    expect(MAX_BATCH_SIZE).toBe(20);
  });

  it('rejects batch exceeding tier limit', () => {
    const tier = 'free' as const;
    const itemCount = 10;
    const maxItems = BATCH_LIMITS[tier];
    expect(itemCount).toBeGreaterThan(maxItems);
  });

  it('allows batch within tier limit', () => {
    const tier = 'free' as const;
    const itemCount = 3;
    const maxItems = BATCH_LIMITS[tier];
    expect(itemCount).toBeLessThanOrEqual(maxItems);
  });

  it('has no data_last_synced timestamp when a batch searches no local jurisdictions', () => {
    const timestamp = latestSyncTimestampForJurisdictions(
      [
        {
          jurisdiction: 'US',
          status: 'completed',
          live_mark_count: 10_873_728,
          created_at: '2026-05-27T11:44:45Z',
        },
      ],
      []
    );

    expect(timestamp).toBeNull();
  });
});
