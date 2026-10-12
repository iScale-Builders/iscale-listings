import { afterEach, expect, it, vi } from 'vitest';
import { TrademarkChecker } from '../../sdk/src/index';
afterEach(() => vi.unstubAllGlobals());
it('forwards optional result caps for single and batch calls without changing omitted requests', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }));
  const checker = new TrademarkChecker({ apiKey: 'fixture', baseUrl: 'https://example.test' });
  await checker.check({ text: 'cat', classes: ['025'], max_results: 100 });
  await checker.checkBatch({ items: [{ text: 'cat', classes: ['025'], max_results: 500 }] });
  await checker.check({ text: 'cat', classes: ['025'] });
  expect(bodies[0]).toMatchObject({ max_results: 100 });
  expect(bodies[1]).toMatchObject({ items: [{ max_results: 500 }] });
  expect(bodies[2]).not.toHaveProperty('max_results');
});
