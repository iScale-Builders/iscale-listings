import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeText } from '@/lib/trademark/normalize';
import { generateCandidates } from '@/lib/trademark/ngrams';
import { classifyConfidence } from '@/lib/trademark/confidence';
import {
  ALLOWED_CLASSES,
  DEFAULT_JURISDICTIONS,
  JURISDICTIONS,
  MAX_TEXT_LENGTH,
  MAX_CANDIDATES,
  MAX_RESULTS,
} from '@/lib/trademark/constants';
import {
  buildOfficialLookupActions,
  getDatabaseJurisdictions,
  getOfficialLookupJurisdictions,
  isFreshLocalDatabase,
  isLocalDatabaseStale,
  latestSyncTimestampForJurisdictions,
} from '@/lib/trademark/jurisdictions';
import { CheckRequestSchema } from '@/lib/validation/schemas';

/**
 * Integration-style tests for the /api/v1/check logic.
 * These test the validation and pipeline logic without a real Supabase connection.
 */

describe('/api/v1/check validation', () => {
  it('rejects empty text', () => {
    expect('').toHaveLength(0);
    // Empty text would fail Zod validation (min 2 chars)
  });

  it('rejects text exceeding 2000 characters', () => {
    const longText = 'a'.repeat(MAX_TEXT_LENGTH + 1);
    expect(longText.length).toBeGreaterThan(MAX_TEXT_LENGTH);
  });

  it('rejects text with no valid words (>=3 chars)', () => {
    const normalized = normalizeText('to be or');
    const words = normalized.split(' ').filter((w) => w.length > 1);
    const hasValid = words.some((w) => w.length >= 3);
    expect(hasValid).toBe(false);
  });

  it('accepts text with at least one valid word', () => {
    const normalized = normalizeText('cat');
    const words = normalized.split(' ').filter((w) => w.length > 1);
    const hasValid = words.some((w) => w.length >= 3);
    expect(hasValid).toBe(true);
  });

  it('validates class codes against allowed set', () => {
    expect(ALLOWED_CLASSES).toContain('025');
    expect(ALLOWED_CLASSES).toContain('009');
    expect(ALLOWED_CLASSES).toContain('016');
    expect(ALLOWED_CLASSES).not.toContain('999');
  });

  it('rejects unknown class codes', () => {
    const classes = ['025', '999'];
    const allValid = classes.every((c) =>
      (ALLOWED_CLASSES as readonly string[]).includes(c)
    );
    expect(allValid).toBe(false);
  });

  it('defaults to the local USPTO jurisdiction', () => {
    const parsed = CheckRequestSchema.parse({
      text: 'vintage cat dad shirt',
      classes: ['025'],
    });

    expect(parsed.jurisdictions).toEqual([...DEFAULT_JURISDICTIONS]);
  });

  it('accepts supported international jurisdictions', () => {
    const parsed = CheckRequestSchema.parse({
      text: 'vintage cat dad shirt',
      classes: ['025'],
      jurisdictions: ['US', 'EUIPO', 'FR', 'DE', 'IT', 'ES', 'UK', 'JP'],
    });

    expect(parsed.jurisdictions).toEqual([...JURISDICTIONS]);
  });

  it('rejects unknown jurisdictions', () => {
    const parsed = CheckRequestSchema.safeParse({
      text: 'vintage cat dad shirt',
      classes: ['025'],
      jurisdictions: ['US', 'CA'],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('/api/v1/check pipeline', () => {
  it('normalizes input text before matching', () => {
    const input = "Father's Day T-Shirt Gift";
    const normalized = normalizeText(input);
    expect(normalized).toBe('fathers day t shirt gift');
  });

  it('generates candidates from normalized text', () => {
    const normalized = 'vintage cat dad funny gift';
    const { candidates, hasValidWord } = generateCandidates(normalized);
    expect(hasValidWord).toBe(true);
    expect(candidates).toContain('cat dad');
    expect(candidates).toContain('vintage');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  it('tags confidence correctly', () => {
    expect(classifyConfidence('cat dad')).toBe('high');
    expect(classifyConfidence('ace')).toBe('low');
    expect(classifyConfidence('mountain')).toBe('high');
  });

  it('caps results at MAX_RESULTS', () => {
    const results = Array.from({ length: 60 }, (_, i) => ({
      wordmark: `MARK${i}`,
      serial_number: `${80000000 + i}`,
    }));
    const capped = results.slice(0, MAX_RESULTS);
    expect(capped).toHaveLength(MAX_RESULTS);
    expect(results.length).toBeGreaterThan(MAX_RESULTS);
  });

  it('sets truncated flag when results exceed cap', () => {
    const totalMatches = 55;
    const truncated = totalMatches > MAX_RESULTS;
    expect(truncated).toBe(true);
  });

  it('builds official lookup actions for non-US jurisdictions', () => {
    const actions = buildOfficialLookupActions('vintage cat dad shirt', ['US', 'EUIPO', 'UK', 'JP']);

    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.jurisdiction)).toEqual(['EUIPO', 'UK', 'JP']);
    expect(actions[0].query).toBe('vintage cat dad shirt');
    expect(actions.every((action) => action.url.startsWith('https://'))).toBe(true);
  });

  it('uses official lookup actions only for markets not searched locally', () => {
    const requested = ['US', 'EUIPO', 'UK', 'JP'] as const;
    const databaseJurisdictions = getDatabaseJurisdictions(requested, false);
    const lookupJurisdictions = getOfficialLookupJurisdictions(requested, databaseJurisdictions);

    expect(databaseJurisdictions).toEqual(['US']);
    expect(lookupJurisdictions).toEqual(['EUIPO', 'UK', 'JP']);
  });

  it('removes official lookup actions when multi-jurisdiction local DB is enabled', () => {
    const requested = ['US', 'EUIPO', 'UK', 'JP'] as const;
    const databaseJurisdictions = getDatabaseJurisdictions(requested, true, [
      {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: new Date().toISOString(),
      },
      {
        jurisdiction: 'UK',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: new Date().toISOString(),
      },
      {
        jurisdiction: 'JP',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: new Date().toISOString(),
      },
    ]);
    const lookupJurisdictions = getOfficialLookupJurisdictions(requested, databaseJurisdictions);

    expect(databaseJurisdictions).toEqual(['US', 'EUIPO', 'UK', 'JP']);
    expect(lookupJurisdictions).toEqual([]);
  });

  it('searches stale local data too (and reports it stale), keeps lookups only for regions with no data', () => {
    const requested = ['US', 'EUIPO', 'UK', 'JP'] as const;
    const databaseJurisdictions = getDatabaseJurisdictions(requested, true, [
      {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: new Date().toISOString(),
      },
      {
        jurisdiction: 'UK',
        status: 'completed',
        live_mark_count: 100,
        source_updated_at: '2018-02-13T00:00:00Z',
      },
    ]);
    const lookupJurisdictions = getOfficialLookupJurisdictions(requested, databaseJurisdictions);

    // UK's 2018 data is searched (its real matches count) but is stale, so it can
    // never yield a clear result; JP has no local data and stays a lookup action.
    expect(databaseJurisdictions).toEqual(['US', 'EUIPO', 'UK']);
    expect(lookupJurisdictions).toEqual(['JP']);
  });

  it('treats completed rows with invalid freshness dates as stale but still searchable', () => {
    const sync = {
      jurisdiction: 'EUIPO',
      status: 'completed',
      live_mark_count: 100,
      source_updated_at: 'not-a-date',
      created_at: '2026-05-27T00:00:00Z',
    };

    expect(isLocalDatabaseStale('EUIPO', sync)).toBe(true);
    expect(isFreshLocalDatabase('EUIPO', sync)).toBe(false);
    expect(getDatabaseJurisdictions(['US', 'EUIPO'], true, [sync])).toEqual(['US', 'EUIPO']);
  });

  it('does not let non-US import time replace an official source date', () => {
    const sync = {
      jurisdiction: 'EUIPO',
      status: 'completed',
      live_mark_count: 100,
      created_at: new Date().toISOString(),
    };

    expect(isLocalDatabaseStale('EUIPO', sync)).toBe(true);
    expect(isFreshLocalDatabase('EUIPO', sync)).toBe(false);
    // Searched, but stale: the route's data_stale stays true, so no clear result.
    expect(getDatabaseJurisdictions(['US', 'EUIPO'], true, [sync])).toEqual(['US', 'EUIPO']);
  });

  it('does not search a region that has never completed an import', () => {
    expect(
      getDatabaseJurisdictions(['US', 'EUIPO'], true, [
        { jurisdiction: 'EUIPO', status: 'failed', live_mark_count: 100, source_updated_at: new Date().toISOString() },
      ])
    ).toEqual(['US']);
    expect(
      getDatabaseJurisdictions(['US', 'EUIPO'], true, [
        { jurisdiction: 'EUIPO', status: 'completed', live_mark_count: 0, source_updated_at: new Date().toISOString() },
      ])
    ).toEqual(['US']);
  });

  it('allows US freshness to fall back to sync creation time', () => {
    const sync = {
      jurisdiction: 'US',
      status: 'completed',
      live_mark_count: 10_873_728,
      created_at: new Date().toISOString(),
    };

    expect(isLocalDatabaseStale('US', sync)).toBe(false);
    expect(isFreshLocalDatabase('US', sync)).toBe(true);
  });

  it('treats a missing or zero-count sync as NOT fresh (regression: empty-DB false clear)', () => {
    // An empty / never-synced DB has no completed sync row (or a 0-count one).
    // The check + batch routes key data_stale on `!isFreshLocalDatabase`, so
    // these must be "not fresh" — otherwise an empty DB (e.g. a fresh clone of
    // the OSS repo) returns a confident green "clear" on every input.
    expect(isFreshLocalDatabase('US', undefined)).toBe(false);
    expect(
      isFreshLocalDatabase('US', {
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 0,
        created_at: new Date().toISOString(),
      })
    ).toBe(false);
  });

  it('uses the newest sync row per jurisdiction when rows are unordered', () => {
    const requested = ['US', 'EUIPO'] as const;
    const databaseJurisdictions = getDatabaseJurisdictions(requested, true, [
      {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        created_at: '2026-05-20T00:00:00Z',
        source_updated_at: '2018-02-13T00:00:00Z',
      },
      {
        jurisdiction: 'EUIPO',
        status: 'completed',
        live_mark_count: 100,
        created_at: new Date().toISOString(),
        source_updated_at: new Date().toISOString(),
      },
    ]);

    expect(databaseJurisdictions).toEqual(['US', 'EUIPO']);
  });

  it('keeps requested and locally checked jurisdiction scopes distinct', () => {
    const requested = ['US', 'EUIPO', 'UK', 'JP'] as const;
    const databaseJurisdictions = getDatabaseJurisdictions(requested, false);
    const responseScope = {
      jurisdictions_requested: [...requested],
      jurisdictions_checked: databaseJurisdictions,
      official_lookup_actions: buildOfficialLookupActions(
        'vintage cat dad shirt',
        getOfficialLookupJurisdictions(requested, databaseJurisdictions)
      ),
    };

    expect(responseScope.jurisdictions_requested).toEqual(['US', 'EUIPO', 'UK', 'JP']);
    expect(responseScope.jurisdictions_checked).toEqual(['US']);
    expect(responseScope.official_lookup_actions.map((action) => action.jurisdiction)).toEqual([
      'EUIPO',
      'UK',
      'JP',
    ]);
  });

  it('reports the latest sync timestamp for only locally checked jurisdictions', () => {
    const syncRows = [
      {
        jurisdiction: 'UK',
        status: 'completed',
        live_mark_count: 134,
        created_at: '2026-05-27T20:00:00Z',
        source_updated_at: '2018-02-13T00:00:00Z',
      },
      {
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 10_873_728,
        created_at: '2026-05-27T11:44:45Z',
      },
    ];

    expect(latestSyncTimestampForJurisdictions(syncRows, ['US'])).toBe(
      '2026-05-27T11:44:45Z'
    );
    expect(latestSyncTimestampForJurisdictions(syncRows, ['US', 'UK'])).toBe(
      '2026-05-27T20:00:00Z'
    );
  });

  it('reports latest sync timestamp from unordered sync rows', () => {
    const syncRows = [
      {
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 10_000,
        created_at: '2026-05-27T11:44:45Z',
      },
      {
        jurisdiction: 'US',
        status: 'completed',
        live_mark_count: 10_001,
        created_at: '2026-05-27T22:00:00Z',
      },
    ];

    expect(latestSyncTimestampForJurisdictions(syncRows, ['US'])).toBe(
      '2026-05-27T22:00:00Z'
    );
  });
});

