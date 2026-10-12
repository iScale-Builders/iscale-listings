import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForTrademarks } from './trademarkCheck';
import type { GeneratedListing } from '../types';
const listing = { fields: [{ content: 'pool party' }] } as GeneratedListing;
afterEach(() => vi.unstubAllGlobals());
describe('advertised result limit negotiation', () => {
  it('retains parent stale status and known hits when an expanded retry fails', async () => {
    const hit = { wordmark: 'Pool Party', matched_text: 'pool party', jurisdiction: 'EUIPO', serial_number: 'fixture', international_class: '025', registration_status: 'pending', confidence: 'high', owner: null };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.max_results) throw new Error('offline');
      return new Response(JSON.stringify({ matches: [hit], total_matches: 52, truncated: true, data_stale: true, jurisdictions_checked: ['EUIPO'], result_limit: 50, result_limit_max: 500 }), { status: 200 });
    }));
    const result = await checkForTrademarks(listing, ['025'], ['EUIPO']);
    expect(result.data_stale).toBe(true);
    expect(result.matches).toEqual([hit]);
  });
  it('retries identical text/scope at100 then500 only with advertised support', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const limit = body.max_results ?? 50;
      return new Response(JSON.stringify({ matches: [], total_matches: limit === 500 ? 0 : 215, truncated: limit !== 500, data_stale: false, jurisdictions_checked: ['EUIPO'], result_limit: limit, result_limit_max: 500 }), { status: 200 });
    }));
    expect((await checkForTrademarks(listing, ['025'], ['EUIPO'])).data_stale).toBe(false);
    expect(bodies.map(body => body.max_results)).toEqual([undefined, 100, 500]);
    for (const body of bodies) expect(body).toMatchObject({ text: 'pool party', classes: ['025'], jurisdictions: ['EUIPO'] });
  });
  it.each(['old', 'ignored', 'unsupported'])('stays unverified with %s limit support', async mode => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return new Response(JSON.stringify({ matches: [], total_matches: 52, truncated: true, data_stale: false, jurisdictions_checked: ['EUIPO'], ...(mode === 'old' ? {} : { result_limit: 50, result_limit_max: mode === 'unsupported' ? 50 : 500 }) }), { status: 200 });
    }));
    expect((await checkForTrademarks(listing, ['025'], ['EUIPO'])).data_stale).toBe(true);
    expect(requests).toHaveLength(mode === 'ignored' ? 2 : 1);
  });
});
