/** Configuration options for the TrademarkChecker client. */
export interface CheckerOptions {
  /** API key for authenticated requests. */
  apiKey?: string;
  /** Base URL of the trademark checker API. Defaults to production. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 10000 (10 seconds). */
  timeoutMs?: number;
}

/** Derived registration status of a mark. */
export type RegistrationStatus = 'registered' | 'pending' | 'abandoned' | 'cancelled';

/** A single trademark match returned by the API. */
export interface TrademarkMatch {
  /** Registry market that produced this match. */
  jurisdiction: JurisdictionCode;
  /** The registered wordmark text. */
  wordmark: string;
  /** The text from the input that matched. */
  matched_text: string;
  /** USPTO serial number. */
  serial_number: string;
  /** USPTO registration number, if registered. */
  registration_number: string | null;
  /** International class code (e.g. "025"). */
  international_class: string;
  /** Name of the trademark owner. */
  owner: string | null;
  /** Registration status (e.g. "LIVE" or "DEAD"). */
  status: string;
  /** Raw registry status code, when available. */
  status_code: string | null;
  /** Derived registration status (registered / pending / abandoned / cancelled). */
  registration_status: RegistrationStatus;
  /** Filing date in ISO format. */
  filing_date: string | null;
  /** Confidence level of the match. */
  confidence: 'high' | 'low';
  /** Link to the USPTO TSDR page. */
  tsdr_url: string;
}

/** Trademark registry market code. */
export type JurisdictionCode = 'US' | 'EUIPO' | 'FR' | 'DE' | 'IT' | 'ES' | 'UK' | 'JP';

/** Official registry lookup action for markets not mirrored locally. */
export interface OfficialLookupAction {
  /** Market code for the official lookup. */
  jurisdiction: Exclude<JurisdictionCode, 'US'>;
  /** User-facing market label. */
  label: string;
  /** Official registry name. */
  registry: string;
  /** Official registry search page. */
  url: string;
  /** Query text to search at the registry. */
  query: string;
  /** Short source-specific guidance. */
  note: string;
}

/** Request payload for a single trademark check. */
export interface CheckRequest {
  /** Returned-match cap, integer 1–500; omitted defaults to 50. */
  max_results?: number;
  /** Text to check for trademark matches. 2-2000 characters. */
  text: string;
  /** International class codes to search (e.g. ["025"]). */
  classes: string[];
  /** Whether to include dead/cancelled marks. Defaults to true. */
  include_dead?: boolean;
  /** Registry markets to check. Defaults to ["US"]. */
  jurisdictions?: JurisdictionCode[];
}

/** Response from a single trademark check. */
export interface CheckResponse {
  /** Actual cap and supported maximum (absent on older servers). */
  result_limit?: number;
  result_limit_max?: number;
  /** Array of trademark matches found. */
  matches: TrademarkMatch[];
  /** Total number of matches (may exceed returned matches if truncated). */
  total_matches: number;
  /** Whether results were truncated due to the 50-match cap. */
  truncated: boolean;
  /** Time spent on the database query in milliseconds. */
  query_time_ms: number;
  /** Length of the input text in characters. */
  text_length: number;
  /** ISO timestamp of last USPTO data sync. */
  data_last_synced: string | null;
  /** True if the checked local data is stale — treat results as unverified, not cleared. */
  data_stale: boolean;
  /** Registry markets requested by the caller. */
  jurisdictions_requested: JurisdictionCode[];
  /** Registry markets searched in the local database. */
  jurisdictions_checked: JurisdictionCode[];
  /** Requested markets that were NOT searched — no screening happened for these. */
  jurisdictions_unchecked?: JurisdictionCode[];
  /** True only when every requested market was searched. Anything else is not a clear result. */
  coverage_complete?: boolean;
  /** Official registry lookup actions for requested markets not searched locally. */
  official_lookup_actions: OfficialLookupAction[];
}

/** A single item in a batch check request. */
export interface BatchItem {
  max_results?: number;
  /** Text to check for trademark matches. */
  text: string;
  /** International class codes to search. */
  classes: string[];
  /** Whether to include dead/cancelled marks. */
  include_dead?: boolean;
  /** Registry markets to check. Defaults to ["US"]. */
  jurisdictions?: JurisdictionCode[];
}

/** Request payload for a batch trademark check. */
export interface BatchRequest {
  /** Array of items to check. Max 20 items. */
  items: BatchItem[];
}

/** Result for a single item in a batch response. */
export interface BatchResultItem {
  result_limit?: number;
  result_limit_max?: number;
  /** Zero-based index of the item in the request. */
  index: number;
  /** Array of trademark matches found. */
  matches: TrademarkMatch[];
  /** Total number of matches. */
  total_matches: number;
  /** Time spent on the database query in milliseconds. */
  query_time_ms: number;
  /** Registry markets requested by the caller. */
  jurisdictions_requested: JurisdictionCode[];
  /** Registry markets searched in the local database. */
  jurisdictions_checked: JurisdictionCode[];
  /** Requested markets that were NOT searched — no screening happened for these. */
  jurisdictions_unchecked?: JurisdictionCode[];
  /** True only when every requested market was searched. */
  coverage_complete?: boolean;
  /** Official registry lookup actions for requested markets not searched locally. */
  official_lookup_actions: OfficialLookupAction[];
  /** True if the checked local data is stale — treat results as unverified, not cleared. */
  data_stale: boolean;
  /** Error details if this individual item failed. */
  error?: { code: string; message: string };
}

/** Response from a batch trademark check. */
export interface BatchResponse {
  /** Array of results, one per input item. */
  results: BatchResultItem[];
  /** Total time spent on all queries in milliseconds. */
  total_query_time_ms: number;
  /** ISO timestamp of last USPTO data sync. */
  data_last_synced: string | null;
}

/** Sync info returned by the health endpoint. */
export interface SyncInfo {
  /** Registry market for this sync record. */
  jurisdiction?: JurisdictionCode;
  /** Source system that provided this sync. */
  source?: string;
  /** Timestamp/date the source data itself was last updated, when known. */
  source_updated_at?: string | null;
  /** Date of the last sync. */
  date: string;
  /** Sync status. */
  status: string;
  /** Number of live marks in the database. */
  live_mark_count: number;
  /** Number of marks added in the last sync. */
  marks_added: number;
  /** Number of marks updated in the last sync. */
  marks_updated: number;
}

/** Per-market database freshness and coverage status. */
export interface JurisdictionHealth {
  /** Registry market code. */
  jurisdiction: JurisdictionCode;
  /** Latest sync status, or not_configured when no local data exists. */
  status: string;
  /** Source system for the local data. */
  source: string | null;
  /** Timestamp of the latest sync row. */
  last_synced_at: string | null;
  /** Timestamp/date the source data itself was last updated, when known. */
  source_updated_at: string | null;
  /** Source sync date. */
  sync_date: string | null;
  /** Live marks in the local database for this market. */
  live_mark_count: number;
  /** Whether the latest data is stale. */
  data_stale: boolean;
  /** Maximum accepted age for this market's source data, in hours. */
  freshness_max_age_hours: number;
  /** Whether this market has a completed local database sync. */
  local_database: boolean;
}

/** Response from the health endpoint. */
export interface HealthResponse {
  /** Overall status. */
  status: string;
  /** API version. */
  version: string;
  /** Database connectivity status. */
  database: string;
  /** Information about the last USPTO sync, or null if never synced. */
  last_sync: SyncInfo | null;
  /** Per-market database freshness and coverage status. */
  jurisdictions?: JurisdictionHealth[];
  /** Whether migration 006 and the multi-market matching RPC are available. */
  multi_jurisdiction_schema_ready?: boolean;
  /** Database schema readiness details. */
  schema?: {
    /** Whether the multi-jurisdiction matching schema is available. */
    multi_jurisdiction_ready: boolean;
    /** Migration required for multi-jurisdiction local database matching. */
    required_migration: string;
  };
  /** Whether the data is considered stale (>48h since last sync). */
  data_stale: boolean;
}

/** Structure of API error responses. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retry_after?: number;
  };
}

/** Options for highlighting trademark matches in the DOM. */
export interface HighlightOptions {
  /** DOM elements to scan for matches. */
  elements: HTMLElement[];
  /** Trademark matches to highlight. */
  matches: TrademarkMatch[];
  /** Callback when a highlighted match is clicked. */
  onClick?: (match: TrademarkMatch, event: MouseEvent) => void;
}
