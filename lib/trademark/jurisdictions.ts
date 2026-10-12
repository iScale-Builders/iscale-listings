import {
  FRESHNESS_HOURS_BY_JURISDICTION,
  JURISDICTION_LABELS,
  type JurisdictionCode,
} from '@/lib/trademark/constants';
import type { OfficialLookupAction } from '@/lib/trademark/types';

const HOUR_MS = 60 * 60 * 1000;

export interface SyncMetadataHealthRow {
  jurisdiction?: string | null;
  status?: string | null;
  live_mark_count?: number | null;
  created_at?: string | null;
  source_updated_at?: string | null;
}

const OFFICIAL_SEARCH_TARGETS: Record<
  Exclude<JurisdictionCode, 'US'>,
  { registry: string; url: string; note: string }
> = {
  EUIPO: {
    registry: 'EUIPO eSearch plus',
    url: 'https://www.euipo.europa.eu/en/search-ip',
    note: 'Search EU trade marks and TMview participating registers.',
  },
  FR: {
    registry: 'INPI Data - base marques',
    url: 'https://www.inpi.fr/base-marques',
    note: 'Search French, EU, and international marks surfaced by INPI.',
  },
  DE: {
    registry: 'DPMAregister',
    url: 'https://www.dpma.de/recherche/dpmaregister/',
    note: 'Search German trade marks in the official DPMA register.',
  },
  IT: {
    registry: 'UIBM / TMview',
    url: 'https://uibm.mise.gov.it/index.php/it/banche-dati/tmview',
    note: 'Search Italian trade marks through UIBM-supported TMview.',
  },
  ES: {
    registry: 'OEPM trademark and trade name search',
    url: 'https://www.oepm.es/en/herramientas/buscador-base-de-datos/buscador-marcas-y-nombres-comerciales/index.html',
    note: 'Search Spanish trade marks and trade names through OEPM.',
  },
  UK: {
    registry: 'UK IPO trade mark search',
    url: 'https://www.gov.uk/search-for-trademark',
    note: 'Search existing UK trade marks before filing or using a mark.',
  },
  JP: {
    registry: 'J-PlatPat',
    url: 'https://www.jpo.go.jp/e/support/j_platpat/trademark_search.html',
    note: 'Use the official JPO/J-PlatPat trademark search workflow.',
  },
};

export function buildOfficialLookupActions(
  query: string,
  jurisdictions: readonly JurisdictionCode[]
): OfficialLookupAction[] {
  const normalizedQuery = query.trim();

  return jurisdictions
    .filter((jurisdiction): jurisdiction is Exclude<JurisdictionCode, 'US'> => jurisdiction !== 'US')
    .map((jurisdiction) => {
      const target = OFFICIAL_SEARCH_TARGETS[jurisdiction];

      return {
        jurisdiction,
        label: JURISDICTION_LABELS[jurisdiction],
        registry: target.registry,
        url: target.url,
        query: normalizedQuery,
        note: target.note,
      };
    });
}

export function getDatabaseJurisdictions(
  jurisdictions: readonly JurisdictionCode[],
  multiJurisdictionEnabled = process.env.ENABLE_MULTI_JURISDICTION_DB === 'true',
  syncRows: readonly SyncMetadataHealthRow[] = []
): JurisdictionCode[] {
  const latestByJurisdiction = latestSyncByJurisdiction(syncRows);

  // Search every region that HAS local data, even if it is out of date: an old
  // copy still finds the marks it holds (skipping it threw real matches away).
  // Freshness is reported separately (data_stale), so an old region can never
  // produce a confident "clear" — only its real matches, or "unverified".
  return jurisdictions.filter((jurisdiction) =>
    jurisdiction === 'US' ||
    (
      multiJurisdictionEnabled &&
      hasLocalData(latestByJurisdiction.get(jurisdiction))
    )
  );
}

/** A completed import with at least one live mark exists for this region. */
export function hasLocalData(sync: SyncMetadataHealthRow | undefined): boolean {
  return !!sync && sync.status === 'completed' && !!sync.live_mark_count && sync.live_mark_count > 0;
}

export function getOfficialLookupJurisdictions(
  requestedJurisdictions: readonly JurisdictionCode[],
  databaseJurisdictions: readonly JurisdictionCode[]
): JurisdictionCode[] {
  const local = new Set(databaseJurisdictions);
  return requestedJurisdictions.filter((jurisdiction) => !local.has(jurisdiction));
}

export function latestSyncTimestampForJurisdictions(
  syncRows: readonly SyncMetadataHealthRow[],
  jurisdictions: readonly JurisdictionCode[]
): string | null {
  const allowed = new Set(jurisdictions);
  const latest = syncRows.reduce<SyncMetadataHealthRow | null>((currentLatest, sync) => {
    const jurisdiction = (sync.jurisdiction ?? 'US') as JurisdictionCode;
    if (sync.status !== 'completed' || !allowed.has(jurisdiction) || !sync.created_at) {
      return currentLatest;
    }

    if (!currentLatest?.created_at) return sync;

    const currentTime = new Date(currentLatest.created_at).getTime();
    const syncTime = new Date(sync.created_at).getTime();
    if (Number.isNaN(syncTime)) return currentLatest;
    if (Number.isNaN(currentTime)) return sync;

    return syncTime > currentTime ? sync : currentLatest;
  }, null);

  return latest?.created_at ?? null;
}

export function isFreshLocalDatabase(
  jurisdiction: JurisdictionCode,
  sync: SyncMetadataHealthRow | undefined,
  now = Date.now()
): boolean {
  if (!sync || sync.status !== 'completed' || !sync.live_mark_count || sync.live_mark_count <= 0) {
    return false;
  }

  return !isLocalDatabaseStale(jurisdiction, sync, now);
}

export function isLocalDatabaseStale(
  jurisdiction: JurisdictionCode,
  sync: SyncMetadataHealthRow | undefined,
  now = Date.now()
): boolean {
  if (!sync || sync.status !== 'completed' || !sync.live_mark_count || sync.live_mark_count <= 0) {
    return false;
  }

  const freshnessBasis = freshnessBasisForJurisdiction(jurisdiction, sync);
  if (!freshnessBasis) return true;

  const freshnessAt = new Date(freshnessBasis).getTime();
  if (Number.isNaN(freshnessAt)) return true;

  const maxAgeHours = FRESHNESS_HOURS_BY_JURISDICTION[jurisdiction] ?? 168;
  return now - freshnessAt > maxAgeHours * HOUR_MS;
}

export function latestSyncByJurisdiction<T extends SyncMetadataHealthRow>(
  syncRows: readonly T[]
): Map<JurisdictionCode, T> {
  const latest = new Map<JurisdictionCode, T>();
  for (const sync of syncRows) {
    const jurisdiction = (sync.jurisdiction ?? 'US') as JurisdictionCode;
    const existing = latest.get(jurisdiction);
    if (!existing || isNewerSync(sync, existing)) {
      latest.set(jurisdiction, sync);
    }
  }
  return latest;
}

function isNewerSync(candidate: SyncMetadataHealthRow, existing: SyncMetadataHealthRow): boolean {
  const candidateTime = syncSortTime(candidate);
  const existingTime = syncSortTime(existing);
  if (candidateTime === null) return false;
  if (existingTime === null) return true;
  return candidateTime > existingTime;
}

function syncSortTime(sync: SyncMetadataHealthRow): number | null {
  const basis = sync.created_at ?? sync.source_updated_at;
  if (!basis) return null;
  const time = new Date(basis).getTime();
  return Number.isNaN(time) ? null : time;
}

function freshnessBasisForJurisdiction(
  jurisdiction: JurisdictionCode,
  sync: SyncMetadataHealthRow
): string | null | undefined {
  if (jurisdiction === 'US') {
    return sync.source_updated_at ?? sync.created_at;
  }

  return sync.source_updated_at;
}
