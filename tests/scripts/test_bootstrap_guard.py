import importlib.util
import sys
import types
import unittest
from pathlib import Path
# Unit-test control flow only; real PostgreSQL catalog acceptance is separate.
sys.modules.setdefault('psycopg2', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('bootstrap_guard', Path(__file__).resolve().parents[2] / 'scripts' / 'bootstrap_postgres.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Cursor:
    def __init__(self, database='isolated', objects=0, schemas=0):
        self.answers = iter([(database,), (objects,), (schemas,)])
        self.queries = []
    def execute(self, sql): self.queries.append(sql)
    def fetchone(self): return next(self.answers)
class GuardTests(unittest.TestCase):
    def test_empty_database_allowed(self):
        cursor = Cursor()
        module.assert_empty_database(cursor)
        self.assertIn('pg_class', cursor.queries[1])
        self.assertIn('pg_proc', cursor.queries[1])
        self.assertIn('pg_type', cursor.queries[1])
        self.assertIn("e.extname='pg_trgm'", cursor.queries[1])
    def test_existing_relation_or_function_or_type_refused(self):
        for kind in ['view', 'materialized view', 'sequence', 'function', 'type']:
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                module.assert_empty_database(Cursor(objects=1))
    def test_existing_schema_refused(self):
        with self.assertRaises(RuntimeError): module.assert_empty_database(Cursor(schemas=1))
    def test_system_database_refused_before_object_queries(self):
        cursor=Cursor(database='postgres')
        with self.assertRaises(RuntimeError): module.assert_empty_database(cursor)
        self.assertEqual(len(cursor.queries), 1)
if __name__ == '__main__': unittest.main()
