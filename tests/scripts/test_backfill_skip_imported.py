"""backfill_direct --skip-imported downloads only daily files not yet imported cleanly, and records new ones.

Run: python -m unittest tests/scripts/test_backfill_skip_imported.py
psycopg2, lxml and the XML helpers are stubbed so this needs only the standard library.
"""

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

pg = types.ModuleType("psycopg2")
pg.OperationalError = type("OperationalError", (Exception,), {})
pg.Error = type("Error", (Exception,), {})
pg.extras = types.ModuleType("psycopg2.extras")
pg.extras.execute_values = lambda *a, **k: None
sys.modules.setdefault("psycopg2", pg)
sys.modules.setdefault("psycopg2.extras", pg.extras)
sys.modules.setdefault("lxml", types.ModuleType("lxml"))
sys.modules["lxml"].etree = types.ModuleType("etree")
sys.modules.setdefault("tm_splitter_adapted", types.SimpleNamespace(extract_trademark=lambda *a, **k: None))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))
import backfill_direct as bd  # noqa: E402

FILES = [{"fileName": f"apc26100{d}.zip"} for d in (3, 4, 5)]


class SkipImportedTest(unittest.TestCase):
    def run_main(self, already, argv_extra):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            if already is not None:
                state.write_text(json.dumps({"files": already}), encoding="utf-8")
            downloaded = []

            def fake_download(fi, dest, key):
                downloaded.append(fi["fileName"])
                z = Path(dest) / fi["fileName"]
                z.write_bytes(b"zip")
                return z

            def fake_extract(zip_path, dest, suffix):
                x = Path(dest) / (Path(zip_path).stem + ".xml")
                x.write_text("<x/>")
                return [x]

            argv = ["backfill_direct.py", "2026-09-29", "2026-10-06", "--record-sync-metadata", *argv_extra]
            with mock.patch.dict(os.environ, {"TM_IMPORTED_FILES_STATE": str(state)}), \
                    mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(bd, "read_vault_creds", return_value=("dsn", "key")), \
                    mock.patch.object(bd, "list_files", return_value=FILES), \
                    mock.patch.object(bd, "download_file", side_effect=fake_download), \
                    mock.patch.object(bd, "extract_suffixed_members", side_effect=fake_extract), \
                    mock.patch.object(bd, "process_xml_to_records", return_value=[{"jurisdiction": "US", "serial_number": "1", "international_class": "025"}]), \
                    mock.patch.object(bd, "connect", return_value=mock.Mock()), \
                    mock.patch.object(bd, "count_live", return_value=100), \
                    mock.patch.object(bd, "upsert", side_effect=lambda conn, batch: len(batch)), \
                    mock.patch.object(bd, "insert_sync_metadata") as sync_meta, \
                    mock.patch.object(bd, "log"):
                rc = bd.main()
            saved = json.loads(state.read_text(encoding="utf-8"))["files"] if state.exists() else None
            return rc, downloaded, saved, sync_meta.called

    def test_skips_imported_and_records_new(self):
        rc, downloaded, saved, synced = self.run_main(["apc261003.zip", "apc261004.zip"], ["--skip-imported"])
        self.assertEqual(rc, 0)
        self.assertEqual(downloaded, ["apc261005.zip"])
        self.assertEqual(saved, ["apc261003.zip", "apc261004.zip", "apc261005.zip"])
        self.assertTrue(synced)

    def test_all_imported_still_records_sync(self):
        rc, downloaded, _, synced = self.run_main([f["fileName"] for f in FILES], ["--skip-imported"])
        self.assertEqual(rc, 0)
        self.assertEqual(downloaded, [])
        self.assertTrue(synced)

    def test_without_flag_downloads_everything_and_writes_no_state(self):
        rc, downloaded, saved, _ = self.run_main(None, [])
        self.assertEqual(rc, 0)
        self.assertEqual(downloaded, [f["fileName"] for f in FILES])
        self.assertIsNone(saved)


if __name__ == "__main__":
    unittest.main()
