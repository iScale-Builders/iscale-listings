export type RegistrationStatus = 'registered' | 'pending' | 'abandoned' | 'cancelled';
export type JurisdictionCode = 'US' | 'EUIPO' | 'FR' | 'DE' | 'IT' | 'ES' | 'UK' | 'JP';

export interface TrademarkMatch {
  jurisdiction: JurisdictionCode;
  wordmark: string;
  matched_text: string;
  serial_number: string;
  registration_number: string | null;
  international_class: string;
  owner: string | null;
  status: string;
  status_code: string | null;
  registration_status: RegistrationStatus;
  filing_date: string | null;
  confidence: 'high' | 'low';
  tsdr_url: string;
}

export interface OfficialLookupAction {
  jurisdiction: Exclude<JurisdictionCode, 'US'>;
  label: string;
  registry: string;
  url: string;
  query: string;
  note: string;
}

export interface CheckRequest {
  max_results?: number;
  text: string;
  classes: string[];
  include_dead?: boolean;
  jurisdictions?: JurisdictionCode[];
}

export interface CheckResponse {
  result_limit?: number;
  result_limit_max?: number;
  matches: TrademarkMatch[];
  total_matches: number;
  truncated: boolean;
  query_time_ms: number;
  text_length: number;
  data_last_synced: string | null;
  data_stale: boolean;
  jurisdictions_requested: JurisdictionCode[];
  jurisdictions_checked: JurisdictionCode[];
  /** Requested but NOT searched locally — no screening happened for these. */
  jurisdictions_unchecked: JurisdictionCode[];
  /** True only when every requested jurisdiction was searched. */
  coverage_complete: boolean;
  official_lookup_actions: OfficialLookupAction[];
}

export interface JurisdictionHealth {
  jurisdiction: JurisdictionCode;
  status: string;
  source: string | null;
  last_synced_at: string | null;
  source_updated_at: string | null;
  sync_date: string | null;
  live_mark_count: number;
  data_stale: boolean;
  freshness_max_age_hours: number;
  local_database: boolean;
}

export interface HealthResponse {
  status: string;
  version: string;
  database: string;
  last_sync: {
    jurisdiction?: JurisdictionCode;
    source?: string;
    source_updated_at?: string | null;
    date: string;
    status: string;
    live_mark_count: number;
    marks_added: number;
    marks_updated: number;
  } | null;
  jurisdictions: JurisdictionHealth[];
  multi_jurisdiction_schema_ready: boolean;
  schema: {
    multi_jurisdiction_ready: boolean;
    required_migration: string;
  };
  data_stale: boolean;
}

export interface BatchItem {
  max_results?: number;
  text: string;
  classes: string[];
  include_dead?: boolean;
  jurisdictions?: JurisdictionCode[];
}

export interface BatchRequest {
  items: BatchItem[];
}

export interface BatchResultItem {
  result_limit?: number;
  result_limit_max?: number;
  index: number;
  matches: TrademarkMatch[];
  total_matches: number;
  /** True when total_matches exceeded the result cap and `matches` is a
   *  (danger-prioritised) subset — the caller has NOT seen every match. */
  truncated: boolean;
  query_time_ms: number;
  jurisdictions_requested: JurisdictionCode[];
  jurisdictions_checked: JurisdictionCode[];
  jurisdictions_unchecked: JurisdictionCode[];
  coverage_complete: boolean;
  official_lookup_actions: OfficialLookupAction[];
  data_stale: boolean;
  error?: { code: string; message: string };
}

export interface BatchResponse {
  results: BatchResultItem[];
  total_query_time_ms: number;
  data_last_synced: string | null;
}

/** Row shape returned by the match_trademarks RPC */
export interface TrademarkRow {
  jurisdiction?: JurisdictionCode;
  serial_number: string;
  registration_number: string | null;
  wordmark: string;
  wordmark_normalized: string;
  international_class: string;
  owner_name: string | null;
  status: string;
  status_code: string | null;
  filing_date: string | null;
}
