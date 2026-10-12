import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgClient } from '@/lib/supabase/pg-client';

function fakePool(rows: Record<string, unknown>[] = [], fail?: Error) {
  const query = vi.fn(async (..._args: unknown[]) => {
    void _args;
    if (fail) throw fail;
    return { rows };
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('PgClient (plain PostgreSQL backend)', () => {
  it('builds a filtered, ordered, limited select', async () => {
    const { pool, query } = fakePool([{ jurisdiction: 'US' }]);
    const r = await new PgClient(pool)
      .from('sync_metadata')
      .select('jurisdiction,status')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(100);
    expect(query).toHaveBeenCalledWith(
      'SELECT "jurisdiction", "status" FROM "sync_metadata" WHERE "status" = $1 ORDER BY "created_at" DESC LIMIT 100',
      ['completed']
    );
    expect(r).toEqual({ data: [{ jurisdiction: 'US' }], error: null });
  });

  it('single() returns the row, or the supabase no-rows code', async () => {
    expect(await new PgClient(fakePool([{ id: 1 }]).pool).from('api_keys').select('id').eq('key_hash', 'h').single()).toEqual({
      data: { id: 1 },
      error: null,
    });
    const none = await new PgClient(fakePool([]).pool).from('api_keys').select('id').single();
    expect(none.error?.code).toBe('PGRST116');
  });

  it('counts with head:true', async () => {
    const { pool, query } = fakePool([{ n: '42' }]);
    const r = await new PgClient(pool).from('trademarks').select('id', { count: 'exact', head: true }).eq('status', 'LIVE');
    expect(query.mock.calls[0][0]).toBe('SELECT count(*)::bigint AS n FROM "trademarks" WHERE "status" = $1');
    expect(r.count).toBe(42);
  });

  it('inserts and updates with parameters', async () => {
    const { pool, query } = fakePool();
    await new PgClient(pool).from('check_history').insert({ input_text: 'x', match_count: 2 });
    expect(query).toHaveBeenLastCalledWith('INSERT INTO "check_history" ("input_text", "match_count") VALUES ($1, $2)', ['x', 2]);
    await new PgClient(pool).from('api_keys').update({ last_used_at: 'now' }).eq('id', 7);
    expect(query).toHaveBeenLastCalledWith('UPDATE "api_keys" SET "last_used_at" = $1 WHERE "id" = $2', ['now', 7]);
  });

  it('calls functions with named arguments', async () => {
    const { pool, query } = fakePool([{ wordmark: 'NIKE' }]);
    const r = await new PgClient(pool).rpc('match_trademarks', { candidate_list: ['nike'], class_list: ['025'], include_dead: false });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM "match_trademarks"("candidate_list" => $1, "class_list" => $2, "include_dead" => $3)',
      [['nike'], ['025'], false]
    );
    expect(r.data).toEqual([{ wordmark: 'NIKE' }]);
  });

  it('turns a database failure into an error result, never a throw', async () => {
    const r = await new PgClient(fakePool([], Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })).pool)
      .from('sync_metadata')
      .select('*');
    expect(r).toEqual({ data: null, error: { message: 'connection refused', code: 'ECONNREFUSED' } });
  });

  it('refuses unsafe identifiers', async () => {
    await expect(new PgClient(fakePool().pool).from('x; drop table y').select('*').execute()).rejects.toThrow(/unsafe SQL identifier/);
  });
});
