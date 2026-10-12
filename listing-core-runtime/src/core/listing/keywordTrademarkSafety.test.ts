import { describe, expect, it } from 'vitest';
import { containsRejectedTerm, mergeKnownKeywordMarks, captureTrademarkScreenScope, trademarkScreenScopeLabel } from './keywordTrademarkSafety';
import { buildExportResult } from '../pipeline/exportResult';
import type { FlaggedMark } from './trademarkCheck';
import type { ValidatedKeyword } from '../types';
const mark: FlaggedMark = { term: 'pool party', wordmark: 'Pool Party', jurisdiction: 'EUIPO', international_class: '009', serial_number: '009202111', registration_status: 'pending' };
describe('current-run known keyword conflicts', () => {
  it('labels the captured checked registries/classes despite later selection changes', () => {
    const jurisdictions = ['EUIPO']; const classes = ['009', '025'];
    const scope = captureTrademarkScreenScope(jurisdictions, classes);
    jurisdictions.push('US'); classes.push('021');
    expect(trademarkScreenScopeLabel(scope)).toBe('EU, class 009, 025');
    expect(trademarkScreenScopeLabel(captureTrademarkScreenScope(['US'], []))).toBe('US, class 025');
    expect(trademarkScreenScopeLabel(captureTrademarkScreenScope(['US', 'EUIPO'], ['025']))).toBe('US + EU, class 025');
  });
  it('keeps known listing alerts through empty or incomplete screens with provenance', () => {
    const flagged = mergeKnownKeywordMarks(['pool party', 'summer pool-party fun', 'pool partyman'], new Map(), [mark]);
    expect([...flagged.keys()]).toEqual(['pool party', 'summer pool-party fun']);
    expect(flagged.get('pool party')).toMatchObject({ jurisdiction: 'EUIPO', serial_number: '009202111', registration_status: 'pending' });
    expect(mergeKnownKeywordMarks(['pool party'], new Map(), []).size).toBe(0);
  });
  it('uses complete word boundaries and excludes known conflicts from shared keyword export', () => {
    expect(containsRejectedTerm('pool partyman', 'pool party')).toBe(false);
    const keywords = ['pool party', 'summer pool-party fun', 'pool partyman'].map(word => ({ word, source: 'who', certified: true, selected: true }) as ValidatedKeyword);
    const result = buildExportResult({ analysis: null, listing: null, trademark: null, keywords, knownRejectedTerms: [mark.term] });
    expect(result.keywords.map(keyword => keyword.word)).toEqual(['pool partyman']);
  });
});
