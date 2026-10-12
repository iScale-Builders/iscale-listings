import { afterEach, describe, expect, it } from 'vitest';
import { createServiceClient } from '@/lib/supabase/server';

describe('createServiceClient', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it('throws when service-role env is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.DATABASE_URL;
    expect(() => createServiceClient()).toThrow(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    );
  });

  it('uses plain PostgreSQL when DATABASE_URL is set', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/trademarks';
    try {
      const client = createServiceClient() as unknown as { rpc: unknown; from: unknown };
      expect(typeof client.rpc).toBe('function');
      expect(client.constructor.name).toBe('PgClient');
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});
