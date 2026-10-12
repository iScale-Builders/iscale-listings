import { describe, expect, it, vi } from 'vitest';
import { CheckRequestSchema, BatchRequestSchema } from '@/lib/validation/schemas';
import { matchTrademarks } from '@/lib/trademark/matcher';
describe('bounded optional result limit', () => {
  it('keeps defaults at50 and validates integer limits through500 for check/batch', () => {
    expect(CheckRequestSchema.parse({ text: 'cat', classes: ['025'] }).max_results).toBe(50);
    expect(BatchRequestSchema.parse({ items: [{ text: 'cat', classes: ['025'] }] }).items[0].max_results).toBe(50);
    for (const max_results of [100, 500]) expect(CheckRequestSchema.parse({ text: 'cat', classes: ['025'], max_results }).max_results).toBe(max_results);
    for (const max_results of [0, 501, 1.5, '100', null]) {
      expect(CheckRequestSchema.safeParse({ text: 'cat', classes: ['025'], max_results }).success).toBe(false);
      expect(BatchRequestSchema.safeParse({ items: [{ text: 'cat', classes: ['025'], max_results }] }).success).toBe(false);
    }
  });
  it('preserves default truncation, expands bounded results and rejects invalid direct limits', async () => {
    const rows = Array.from({ length: 520 }, (_, index) => ({ jurisdiction: 'US', wordmark: `Cat ${index}`, wordmark_normalized: 'cat', serial_number: String(index), status: 'LIVE', registration_number: '1', international_class: '025' }));
    const client = { rpc: vi.fn(async () => ({ data: rows, error: null })) } as never;
    expect((await matchTrademarks('cat', ['025'], client)).matches).toHaveLength(50);
    const expanded = await matchTrademarks('cat', ['025'], client, false, ['US'], 500);
    expect(expanded.matches).toHaveLength(500);
    expect(expanded.totalMatches).toBe(520);
    expect(expanded.truncated).toBe(true);
    await expect(matchTrademarks('cat', ['025'], client, false, ['US'], 501)).rejects.toThrow('Invalid result limit');
  });
});
