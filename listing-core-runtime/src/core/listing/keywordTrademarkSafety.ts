import type { FlaggedMark, TrademarkMatch } from './trademarkCheck';

export interface TrademarkScreenScope { jurisdictions: string[]; classes: string[] }
export function captureTrademarkScreenScope(jurisdictions: readonly string[], classes: readonly string[]): TrademarkScreenScope {
  return { jurisdictions: [...jurisdictions], classes: classes.length ? [...classes] : ['025'] };
}
export function trademarkScreenScopeLabel(scope: TrademarkScreenScope | null): string {
  if (!scope) return 'saved scope unavailable — re-check';
  return `${scope.jurisdictions.map(jurisdiction => jurisdiction === 'EUIPO' ? 'EU' : jurisdiction).join(' + ')}, class ${scope.classes.join(', ')}`;
}

/** Match full normalized words, never substrings of neighboring safe words. */
export function containsRejectedTerm(keyword: string, term: string): boolean {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const candidate = words(keyword);
  const rejected = words(term);
  return rejected.length > 0 && candidate.some((_, start) => rejected.every((word, offset) => candidate[start + offset] === word));
}

/** Only the caller's current-run marks are accepted; this helper stores no state. */
export function mergeKnownKeywordMarks(terms: string[], screened: Map<string, TrademarkMatch>, known: readonly FlaggedMark[] = []): Map<string, TrademarkMatch> {
  const merged = new Map(screened);
  for (const mark of known) for (const term of terms) {
    if (!containsRejectedTerm(term, mark.term)) continue;
    merged.set(term.toLowerCase(), {
      wordmark: mark.wordmark, matched_text: mark.term, serial_number: mark.serial_number,
      international_class: mark.international_class, owner: mark.owner ?? null,
      jurisdiction: mark.jurisdiction === 'EUIPO' ? 'EUIPO' : 'US',
      registration_status: mark.registration_status === 'pending' ? 'pending' : 'registered', confidence: 'high',
    });
  }
  return merged;
}
