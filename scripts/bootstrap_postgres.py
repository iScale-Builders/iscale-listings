"""Apply the checked-in schema only to an empty, user-created PostgreSQL database.
Requires explicit --apply; never drops tables, creates roles, or restores data.
"""
import argparse
import os
from pathlib import Path
import psycopg2

def assert_empty_database(cursor):
    cursor.execute('SELECT current_database()')
    if cursor.fetchone()[0] in ('postgres', 'template0', 'template1'):
        raise RuntimeError('Refusing system database')
    # Relations include views/materialized views/sequences/indexes, not just tables.
    # Only objects owned by pg_trgm are allowed in public before bootstrap.
    cursor.execute("""
      SELECT count(*) FROM (
        SELECT 'pg_class'::regclass AS catalog, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        UNION ALL SELECT 'pg_proc'::regclass, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        UNION ALL SELECT 'pg_type'::regclass, t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
        UNION ALL SELECT 'pg_operator'::regclass, o.oid FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname='public'
      ) objects WHERE NOT EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
        WHERE d.classid=objects.catalog AND d.objid=objects.oid AND d.deptype='e' AND e.extname='pg_trgm'
      )
    """)
    if cursor.fetchone()[0]:
        raise RuntimeError('Refusing existing user objects; create a separate empty database')
    cursor.execute("SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')")
    if cursor.fetchone()[0]:
        raise RuntimeError('Refusing existing user schemas')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply to the empty database named by DATABASE_URL or TM_DB_URL')
    args = parser.parse_args()
    if not args.apply:
        parser.error('Read docs/setup/database-postgres.md first; --apply is required')
    dsn = os.environ.get('DATABASE_URL') or os.environ.get('TM_DB_URL')
    if not dsn:
        parser.error('Set DATABASE_URL or TM_DB_URL privately; do not pass it on the command line')
    migrations = sorted((Path(__file__).resolve().parent.parent / 'supabase' / 'migrations').glob('*.sql'))
    with psycopg2.connect(dsn) as connection:
        with connection.cursor() as cursor:
            assert_empty_database(cursor)
            cursor.execute('SET LOCAL search_path TO public')
            for migration in migrations:
                cursor.execute(migration.read_text(encoding='utf-8'))
            cursor.execute("SELECT to_regclass('public.trademarks'), to_regclass('public.api_keys'), EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm')")
            tables = cursor.fetchone()
            if not all(tables):
                raise RuntimeError('Schema verification failed; transaction will roll back')
    print(f'Schema applied transactionally: {len(migrations)} migrations; tables and pg_trgm verified. No trademark data imported.')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Schema bootstrap failed or refused; transaction rolled back. Inspect database permissions/migrations privately; no connection value printed.')
