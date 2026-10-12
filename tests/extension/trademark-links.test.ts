import { describe, expect, it } from 'vitest';
import { euipoTrademarkUrl, normalizeJurisdictions, trademarkRecordUrl } from '../../extension/shared';

describe('trademark record links', () => {
  it('builds the EUIPO eSearch record URL for EU marks', () => {
    expect(euipoTrademarkUrl('019059592')).toBe('https://euipo.europa.eu/eSearch/#details/trademarks/019059592');
    expect(euipoTrademarkUrl('19059592')).toBe('https://euipo.europa.eu/eSearch/#details/trademarks/019059592');
  });

  it('ignores a stale API link for EU marks', () => {
    const url = trademarkRecordUrl({
      jurisdiction: 'EUIPO',
      serial_number: '019059592',
      tsdr_url: 'https://www.euipo.europa.eu/en/search-ip/trademarks/019059592',
    });
    expect(url).toBe('https://euipo.europa.eu/eSearch/#details/trademarks/019059592');
  });

  it('keeps the API USPTO link for US marks and blocks unsafe ones', () => {
    expect(trademarkRecordUrl({ jurisdiction: 'US', serial_number: '1', tsdr_url: 'https://tsdr.uspto.gov/#caseNumber=1' }))
      .toBe('https://tsdr.uspto.gov/#caseNumber=1');
    expect(trademarkRecordUrl({ serial_number: '7', tsdr_url: 'javascript:alert(1)' })).toContain('tsdr.uspto.gov/#caseNumber=7');
  });
});

describe('normalizeJurisdictions', () => {
  it('defaults to US + EU and keeps valid subsets in order', () => {
    expect(normalizeJurisdictions(undefined)).toEqual(['US', 'EUIPO']);
    expect(normalizeJurisdictions(['EUIPO'])).toEqual(['EUIPO']);
    expect(normalizeJurisdictions(['eu', 'us'])).toEqual(['US', 'EUIPO']);
    expect(normalizeJurisdictions(['XX'])).toEqual(['US', 'EUIPO']);
  });
});