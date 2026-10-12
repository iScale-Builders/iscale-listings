import { normalizeText } from './normalize';
import { generateCandidates, CandidateOverflowError } from './ngrams';
import { classifyConfidence } from './confidence';
import { MAX_RESULTS, MAX_RPC_CANDIDATES } from './constants';
import type { TrademarkMatch, TrademarkRow, RegistrationStatus, JurisdictionCode } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface MatchResult {
  matches: TrademarkMatch[];
  totalMatches: number;
  truncated: boolean;
  queryTimeMs: number;
  candidates: string[];
}

/**
 * Map a mark to a human-readable registration status.
 *
 * The presence of a registration number is the reliable signal: a mark that has
 * registered carries a real number; an application — including an Intent-to-Use
 * mark still in the post-allowance extension phase — does not. Status (LIVE/DEAD)
 * then splits four ways:
 *   LIVE + registered -> 'registered'
 *   LIVE + no reg     -> 'pending'    (application / ITU awaiting Statement of Use)
 *   DEAD + registered -> 'cancelled'
 *   DEAD + no reg     -> 'abandoned'
 *
 * We deliberately do NOT infer status from status_code ranges. That misread codes
 * like 730/731 ("Extension Granted", a live ITU application) as cancelled, which
 * produced a false "cancelled" on live, enforceable marks (e.g. Lacoste ALLIGATOR).
 */
function deriveRegistrationStatus(
  status: string,
  registrationNumber: string | null,
): RegistrationStatus {
  // A real registration number is non-empty and not the all-zeros placeholder.
  const hasRegistration = !!registrationNumber && !/^0+$/.test(registrationNumber);
  if (status === 'DEAD') {
    return hasRegistration ? 'cancelled' : 'abandoned';
  }
  return hasRegistration ? 'registered' : 'pending';
}

/**
 * Public EUIPO record page for an EU trade mark number. eSearch plus is a
 * single-page app, so the record lives in the URL hash:
 *   https://euipo.europa.eu/eSearch/#details/trademarks/019059592
 * (The old `www.euipo.europa.eu/en/search-ip/trademarks/<n>` path never existed
 * and 404s for every mark.) EUTM numbers are 9 digits; restore leading zeros
 * if a source dropped them.
 */
export function euipoTrademarkUrl(serialNumber: string): string {
  const raw = String(serialNumber ?? '').trim();
  if (!raw) return '';
  const serial = /^\d{1,9}$/.test(raw) ? raw.padStart(9, '0') : raw;
  return `https://euipo.europa.eu/eSearch/#details/trademarks/${encodeURIComponent(serial)}`;
}

function trademarkUrl(jurisdiction: JurisdictionCode, serialNumber: string): string {
  if (jurisdiction === 'US') {
    return `https://tsdr.uspto.gov/#caseNumber=${serialNumber}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`;
  }

  if (jurisdiction === 'EUIPO') {
    return euipoTrademarkUrl(serialNumber);
  }

  return '';
}

/**
 * Orchestrator: normalize -> ngrams -> RPC call -> confidence -> sort -> cap 50
 */
export async function matchTrademarks(
  text: string,
  classes: string[],
  supabase: SupabaseClient,
  includeDead: boolean = true,
  jurisdictions: readonly JurisdictionCode[] = ['US']
): Promise<MatchResult> {
  const startTime = performance.now();

  // 1. Normalize
  const normalized = normalizeText(text);

  // 2. Generate candidates (may throw CandidateOverflowError)
  const { candidates } = generateCandidates(normalized);

  if (candidates.length === 0) {
    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      queryTimeMs: Math.round(performance.now() - startTime),
      candidates: [],
    };
  }

  // 3. Query via RPC. Keep the existing USPTO RPC path for backward
  // compatibility until the multi-jurisdiction migration is applied.
  const useJurisdictionRpc =
    jurisdictions.length !== 1 || jurisdictions[0] !== 'US';

  // Keep each exact-index query bounded. Supporting longer registered phrases
  // raises the candidate count above the old 500-candidate request ceiling; a
  // single large ANY(array) call was materially slower in production than a
  // few bounded calls. Run sequentially to avoid multiplying DB load when the
  // extension checks several listing fields concurrently.
  const rows: TrademarkRow[] = [];
  for (let start = 0; start < candidates.length; start += MAX_RPC_CANDIDATES) {
    const candidateBatch = candidates.slice(start, start + MAX_RPC_CANDIDATES);
    const { data, error } = useJurisdictionRpc
      ? await supabase.rpc('match_trademarks_by_jurisdiction', {
        candidate_list: candidateBatch,
        class_list: classes,
        include_dead: includeDead,
        jurisdiction_list: jurisdictions,
      })
      : await supabase.rpc('match_trademarks', {
        candidate_list: candidateBatch,
        class_list: classes,
        include_dead: includeDead,
      });

    if (error) {
      throw error;
    }
    rows.push(...((data ?? []) as TrademarkRow[]));
  }

  // 4. Format and tag confidence + registration status
  const matches: TrademarkMatch[] = rows.map((row) => ({
    jurisdiction: row.jurisdiction ?? 'US',
    wordmark: row.wordmark,
    matched_text: findOriginalCase(text, row.wordmark_normalized),
    serial_number: row.serial_number,
    registration_number: row.registration_number,
    international_class: row.international_class,
    owner: row.owner_name,
    status: row.status,
    status_code: row.status_code,
    registration_status: deriveRegistrationStatus(row.status, row.registration_number),
    filing_date: row.filing_date,
    confidence: classifyConfidence(row.wordmark_normalized),
    tsdr_url: trademarkUrl(row.jurisdiction ?? 'US', row.serial_number),
  }));

  // 5. Sort so the MAX_RESULTS cap can never drop a more dangerous mark in
  // favour of a weaker one. Order: LIVE before DEAD, then within a status tier
  // registered (enforceable) before pending application before anything else,
  // then high confidence, then alphabetical. Without the registration tier an
  // enforceable registered mark could be truncated below the cap by 50 weaker
  // LIVE marks that merely sort earlier alphabetically.
  const dangerRank = (m: TrademarkMatch): number =>
    m.registration_status === 'registered' ? 0
      : m.registration_status === 'pending' ? 1
        : 2;
  matches.sort((a, b) => {
    // LIVE first, DEAD last
    if (a.status !== b.status) {
      return a.status === 'LIVE' ? -1 : 1;
    }
    const ra = dangerRank(a);
    const rb = dangerRank(b);
    if (ra !== rb) {
      return ra - rb;
    }
    if (a.confidence !== b.confidence) {
      return a.confidence === 'high' ? -1 : 1;
    }
    return a.wordmark.localeCompare(b.wordmark);
  });

  // 6. Cap at MAX_RESULTS
  const truncated = matches.length > MAX_RESULTS;
  const queryTimeMs = Math.round(performance.now() - startTime);

  return {
    matches: matches.slice(0, MAX_RESULTS),
    totalMatches: matches.length,
    truncated,
    queryTimeMs,
    candidates,
  };
}

/**
 * Find the original-case version of a normalized match in the input text.
 * Falls back to the normalized form if no match found.
 */
function findOriginalCase(
  originalText: string,
  normalizedWordmark: string
): string {
  const normalizedInput = normalizeText(originalText);
  const idx = normalizedInput.indexOf(normalizedWordmark);
  if (idx === -1) return normalizedWordmark;

  // Map the index back to the original text by walking both strings
  // Simple approach: find the substring positionally
  // Since normalization can change string length, we do a case-insensitive search
  const words = normalizedWordmark.split(' ');
  const pattern = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\-]+');
  const regex = new RegExp(pattern, 'i');
  const match = originalText.match(regex);
  return match ? match[0] : normalizedWordmark;
}

export { CandidateOverflowError };
