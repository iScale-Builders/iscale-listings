"""download_file retries USPTO rate limits (HTTP 429/503) instead of failing the whole daily sync.

Run: python -m unittest tests/scripts/test_sync_daily_delta_retry.py
The XML helpers are stubbed so this needs only the standard library.
"""

import io
import os
import sys
import tempfile
import types
import unittest
from email.message import Message
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

sys.modules.setdefault("lxml", types.ModuleType("lxml"))
sys.modules["lxml"].etree = types.ModuleType("etree")
sys.modules.setdefault("tm_splitter_adapted", types.SimpleNamespace(extract_trademark=lambda *a, **k: None))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))
import sync_daily_delta as sdd  # noqa: E402


def http_error(code, retry_after=None):
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return HTTPError("https://api.uspto.gov/x", code, "Too Many Requests", headers, io.BytesIO(b""))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class DownloadRetryTest(unittest.TestCase):
    def run_download(self, outcomes):
        calls = iter(outcomes)

        def fake_open(req, timeout=None):
            outcome = next(calls)
            if isinstance(outcome, Exception):
                raise outcome
            return FakeResponse(outcome)

        opener = mock.Mock()
        opener.open.side_effect = fake_open
        waits = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("urllib.request.build_opener", return_value=opener), \
                mock.patch.object(sdd.time, "sleep", side_effect=waits.append), \
                mock.patch.object(sdd, "log"):
            path = sdd.download_file({"fileName": "apc261005.zip"}, Path(tmp), "key")
            data = path.read_bytes() if path else None
        return path, data, waits, opener.open.call_count

    def test_retries_429_then_succeeds(self):
        path, data, waits, calls = self.run_download([http_error(429), http_error(429), b"zipbytes"])
        self.assertIsNotNone(path)
        self.assertEqual(data, b"zipbytes")
        self.assertEqual(waits, [30, 60])
        self.assertEqual(calls, 3)

    def test_honours_retry_after_capped(self):
        _, _, waits, _ = self.run_download([http_error(429, retry_after=7), http_error(503, retry_after=9999), b"ok"])
        self.assertEqual(waits, [7, 300])

    def test_gives_up_after_four_retries(self):
        path, _, waits, calls = self.run_download([http_error(429)] * 5)
        self.assertIsNone(path)
        self.assertEqual(waits, [30, 60, 120, 240])
        self.assertEqual(calls, 5)

    def test_other_errors_fail_at_once(self):
        path, _, waits, calls = self.run_download([http_error(404)])
        self.assertIsNone(path)
        self.assertEqual(waits, [])
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
