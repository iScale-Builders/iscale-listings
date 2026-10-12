import { describe, expect, it } from 'vitest';
import { euipoTrademarkUrl } from '../../lib/trademark/matcher';

describe('API EUIPO tsdr_url', () => {
  it('points at the EUIPO eSearch record', () => {
    expect(euipoTrademarkUrl('019059592')).toBe('https://euipo.europa.eu/eSearch/#details/trademarks/019059592');
    expect(euipoTrademarkUrl('18000001')).toBe('https://euipo.europa.eu/eSearch/#details/trademarks/018000001');
  });
});