import { Pool, type PoolConfig } from 'pg';

/**
 * Plain-PostgreSQL backend for self-hosting without Supabase (DATABASE_URL).
 *
 * It implements only the small slice of the supabase-js query builder the API
 * uses, so every route keeps one code path: from(table).select(cols, {count,
 * head}).eq().order().limit().single(), insert(row), update(row).eq(), and
 * rpc(fn, namedArgs). Results keep supabase-js's shape ({ data, error, count })
 * and its "no rows" code for .single() (PGRST116), which callers already handle.
 */

type Row = Record<string, unknown>;
interface PgResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function columns(cols: string): string {
  const list = cols.split(',').map((c) => c.trim()).filter(Boolean);
  return list.length === 0 || (list.length === 1 && list[0] === '*') ? '*' : list.map(ident).join(', ');
}

async function run(pool: Pool, sql: string, params: unknown[]): Promise<{ rows: Row[]; error: PgResult['error'] }> {
  try {
    const r = await pool.query(sql, params);
    return { rows: r.rows as Row[], error: null };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { rows: [], error: { message: err.message ?? String(e), code: err.code } };
  }
}

class Query implements PromiseLike<PgResult> {
  private filters: [string, unknown][] = [];
  private orderBy: [string, boolean] | null = null;
  private limitN: number | null = null;
  private one = false;

  constructor(
    private pool: Pool,
    private table: string,
    private op: 'select' | 'insert' | 'update',
    private payload: { cols?: string; count?: boolean; head?: boolean; row?: Row }
  ) {}

  eq(col: string, value: unknown): this {
    this.filters.push([col, value]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = [col, opts?.ascending !== false];
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.one = true;
    return this;
  }

  private where(params: unknown[]): string {
    if (!this.filters.length) return '';
    return ` WHERE ${this.filters.map(([c, v]) => `${ident(c)} = $${params.push(v)}`).join(' AND ')}`;
  }

  async execute(): Promise<PgResult> {
    const params: unknown[] = [];
    const table = ident(this.table);
    if (this.op === 'insert' || this.op === 'update') {
      const row = this.payload.row ?? {};
      const keys = Object.keys(row);
      const sql =
        this.op === 'insert'
          ? `INSERT INTO ${table} (${keys.map(ident).join(', ')}) VALUES (${keys.map((k) => `$${params.push(row[k])}`).join(', ')})`
          : `UPDATE ${table} SET ${keys.map((k) => `${ident(k)} = $${params.push(row[k])}`).join(', ')}${this.where(params)}`;
      const { error } = await run(this.pool, sql, params);
      return { data: null, error };
    }
    if (this.payload.count && this.payload.head) {
      const { rows, error } = await run(this.pool, `SELECT count(*)::bigint AS n FROM ${table}${this.where(params)}`, params);
      return { data: null, error, count: error ? null : Number(rows[0]?.n ?? 0) };
    }
    let sql = `SELECT ${columns(this.payload.cols ?? '*')} FROM ${table}${this.where(params)}`;
    if (this.orderBy) sql += ` ORDER BY ${ident(this.orderBy[0])} ${this.orderBy[1] ? 'ASC' : 'DESC'}`;
    if (this.limitN != null) sql += ` LIMIT ${Math.max(0, Math.floor(this.limitN))}`;
    const { rows, error } = await run(this.pool, sql, params);
    if (error) return { data: null, error };
    if (this.one) {
      return rows.length
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'no rows returned', code: 'PGRST116' } };
    }
    return { data: rows, error: null };
  }

  then<A = PgResult, B = never>(
    onfulfilled?: ((value: PgResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export class PgClient {
  constructor(private pool: Pool) {}

  from(table: string) {
    const pool = this.pool;
    return {
      select: (cols = '*', opts?: { count?: 'exact'; head?: boolean }) =>
        new Query(pool, table, 'select', { cols, count: opts?.count === 'exact', head: opts?.head }),
      insert: (row: Row) => new Query(pool, table, 'insert', { row }),
      update: (row: Row) => new Query(pool, table, 'update', { row }),
    };
  }

  async rpc(fn: string, args: Row): Promise<PgResult> {
    const params: unknown[] = [];
    const named = Object.keys(args).map((k) => `${ident(k)} => $${params.push(args[k])}`).join(', ');
    const { rows, error } = await run(this.pool, `SELECT * FROM ${ident(fn)}(${named})`, params);
    return { data: error ? null : rows, error };
  }
}

let pool: Pool | null = null;

/** One shared pool per server process. */
export function createPgClient(connectionString: string, extra: PoolConfig = {}): PgClient {
  pool ??= new Pool({ connectionString, max: 10, ...extra });
  return new PgClient(pool);
}
