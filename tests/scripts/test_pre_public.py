import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class AnnualTests(unittest.TestCase):
    def test_download_failure_exits_nonzero(self):
        m = module('download_uspto')
        with tempfile.TemporaryDirectory() as temp, patch.object(sys, 'argv', ['download', '--api-key', 'fixture', '--output-dir', temp]), patch.object(m, 'get_all_files', return_value=[{'fileName': 'fixture.zip'}]), patch.object(m, 'download_file', return_value=False), patch.object(m.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                m.main()
            self.assertEqual(result.exception.code, 1)

    def test_bad_extraction_exits_nonzero(self):
        m = module('download_uspto')
        with tempfile.TemporaryDirectory() as temp, patch.object(sys, 'argv', ['download', '--api-key', 'fixture', '--output-dir', temp]), patch.object(m, 'get_all_files', return_value=[{'fileName': 'fixture.zip'}]), patch.object(m, 'download_file', return_value=True), patch.object(m, 'extract_zip', return_value=0), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                m.main()

    def test_direct_count_and_metadata_guard(self):
        m = module('load_uspto')
        for count, errors, allowed in [(0, 0, False), (2999999, 0, False), (3000000, 1, False), (3000000, 0, True)]:
            with self.subTest(count=count, errors=errors), tempfile.TemporaryDirectory() as temp:
                Path(temp, 'fixture.xml').write_text('fixture')
                cur = Mock(); cur.fetchone.return_value = (count,)
                conn = Mock(); conn.cursor.return_value = cur
                pg = types.SimpleNamespace(connect=Mock(return_value=conn))
                stats = dict(processed=1, inserted=1, skipped=0, errors=errors)
                with patch.dict(sys.modules, psycopg2=pg), patch.object(sys, 'argv', ['load', temp, '--db-url', 'fixture']), patch.object(m, 'process_xml_psycopg2', return_value=stats), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    if allowed:
                        m.main()
                    else:
                        with self.assertRaises(SystemExit) as result:
                            m.main()
                        self.assertEqual(result.exception.code, 1)
                sql = [call.args[0] for call in cur.execute.call_args_list]
                self.assertIn("jurisdiction = 'US'", sql[0])
                self.assertEqual(any('INSERT INTO sync_metadata' in q for q in sql), allowed)

    def test_rest_count_exact_and_metadata_failure(self):
        m = module('load_uspto')
        response = Mock(); response.headers = {'Content-Range': '*/3000000'}
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        with patch.object(m, 'urlopen', return_value=response) as open_url:
            _, count, _ = m.make_rest_inserter('https://example.invalid', 'fixture')
            self.assertEqual(count(), 3000000)
            request = open_url.call_args.args[0]
            self.assertIn('jurisdiction=eq.US', request.full_url)
            self.assertEqual(request.get_header('Prefer'), 'count=exact')
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, 'fixture.xml').write_text('fixture')
            with patch.dict(os.environ, {}, clear=True), patch.object(sys, 'argv', ['load', temp, '--supabase-url', 'https://example.invalid', '--service-key', 'fixture']), patch.object(m, 'make_rest_inserter', return_value=(Mock(), lambda: 3000000, lambda *a: False)), patch.object(m, 'process_xml_rest', return_value=dict(processed=1, inserted=1, skipped=0, errors=0)), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    m.main()


class LifecycleTests(unittest.TestCase):
    def test_restore_lookup_literals_match_production_normalization(self):
        from text_normalize import normalize_text
        sql = (ROOT / 'scripts/restore_evidence.sql').read_text()
        import re
        phrase_array = re.search(r"match_trademarks_by_jurisdiction\(\s*ARRAY\[([^]]+)\]", sql).group(1)
        literals = re.findall(r"'([^']+)'", phrase_array)
        self.assertEqual(literals, [normalize_text('NIKE'), normalize_text('JUST DO IT')])
        signature = (ROOT / 'supabase/migrations/009_remove_legacy_uspto_match_overload.sql').read_text()
        self.assertRegex(signature, r'(?s)match_trademarks_by_jurisdiction\(\s*candidate_list TEXT\[\],\s*class_list TEXT\[\],\s*include_dead BOOLEAN.*?jurisdiction_list TEXT\[\]')
        # Restore evidence must never mutate either source or scratch data.
        statements = '\n'.join(line for line in sql.splitlines() if not line.strip().startswith('--'))
        self.assertRegex(statements, r'BEGIN TRANSACTION READ ONLY;')
        self.assertNotRegex(statements, r'(?i)\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE)\b')

    def test_local_hash_precedes_prune_and_failure_retains_old(self):
        m = module('local_lifecycle')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, TM_DB_URL='postgresql://owner:fixture@localhost/fixture?sslmode=require'):
            work = Path(temp, 'work'); work.mkdir()
            target = Path(temp, 'target'); target.mkdir()
            old = target / 'trademarks-20000101.dump'; old.write_bytes(b'old')
            def fake_run(args, **kw):
                if 'pg_dump' in args[0]:
                    Path(args[-1]).write_bytes(b'valid dump')
                    self.assertEqual(kw['env']['PGSSLMODE'], 'require')
                    self.assertNotIn('fixture@', ' '.join(args))
                return subprocess.CompletedProcess(args, 0, stdout='TABLE DATA public trademarks owner')
            with patch.object(m, 'run', side_effect=fake_run), patch.object(m, 'digest', side_effect=['one', 'different']):
                with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                    m.backup(str(target), work, '', 1)
            self.assertTrue(old.exists())
            with patch.object(m, 'run', side_effect=fake_run):
                m.backup(str(target), work, '', 1)
            self.assertFalse(old.exists())
            self.assertEqual(len(list(target.glob('*.dump'))), 1)

    def test_ssh_hash_failure_does_not_prune(self):
        m = module('local_lifecycle')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, TM_DB_URL='postgresql://owner:fixture@localhost/fixture'):
            work = Path(temp)
            calls = []
            def fake(args, **kw):
                calls.append(args)
                if 'pg_dump' in args[0]:
                    Path(args[-1]).write_bytes(b'dump')
                text = 'wronghash file' if 'sha256sum' in args[-1] else 'TABLE DATA public trademarks owner'
                return subprocess.CompletedProcess(args, 0, stdout=text)
            with patch.object(m, 'run', side_effect=fake):
                with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                    m.backup('backup-host:/private/backup', work, '', 1)
            self.assertFalse(any('xargs' in str(c) for c in calls))

    def test_pipeline_gating_and_risk_exit(self):
        m = module('local_lifecycle')
        for fail, scan_exit in [('us', 0), ('eu', 0), ('health', 0), ('backup', 0), (None, 2), (None, 1)]:
            with self.subTest(fail=fail, scan=scan_exit), tempfile.TemporaryDirectory() as temp:
                private = Path(temp, 'private.env'); private.write_text('TM_DB_URL=fixture')
                calls = []
                def fake(args, **kw):
                    stage = 'us' if 'backfill_direct.py' in args[1] else 'eu' if 'import_euipo.py' in args[1] else 'health'
                    calls.append(stage)
                    if fail == stage:
                        raise RuntimeError('fixture failure')
                def dump(*args):
                    calls.append('backup')
                    if fail == 'backup':
                        raise RuntimeError('fixture backup failure')
                    return 'fixturehash'
                def scan(args):
                    calls.append('scan')
                    return subprocess.CompletedProcess(args, scan_exit)
                with patch.object(sys, 'argv', ['lifecycle', '--env-file', str(private), '--work-dir', str(Path(temp, 'work')), '--backup-target', str(Path(temp, 'backup'))]), patch.object(m, 'run', side_effect=fake), patch.object(m, 'backup', side_effect=dump), patch.object(m.subprocess, 'run', side_effect=scan), patch.object(m.os, 'chdir'):
                    if fail or scan_exit == 1:
                        with self.assertRaises(RuntimeError):
                            m.main()
                    else:
                        self.assertEqual(m.main(), 2)
                if fail:
                    self.assertNotIn('scan', calls)
                if fail in ('us', 'eu', 'health'):
                    self.assertNotIn('backup', calls)
                if not fail:
                    self.assertLess(calls.index('backup'), calls.index('scan'))

    def test_launchagent_arguments_and_restart(self):
        m = module('register_macos')
        value = m.agents('/python', '/node', '/private/update.env', '/backup', '/pg', Path('/work'))
        self.assertTrue(value['com.iscale-listings.api']['KeepAlive'])
        self.assertEqual(value['com.iscale-listings.api']['ProgramArguments'][-1], '127.0.0.1')
        self.assertIn('--backup-target', value['com.iscale-listings.update']['ProgramArguments'])
        self.assertEqual(value['com.iscale-listings.update']['StartCalendarInterval']['Hour'], 8)

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell sandbox')
    def test_windows_real_updater_stage_gating(self):
        for us, health, dump, scan, expected in [(1, 0, 0, 0, 1), (0, 3, 0, 0, 1), (0, 0, 1, 0, 1), (0, 0, 0, 2, 2), (0, 0, 0, 1, 1)]:
            with self.subTest(us=us, health=health, dump=dump, scan=scan), tempfile.TemporaryDirectory() as temp:
                work = Path(temp, 'work'); work.mkdir()
                (work / 'last-euipo.txt').write_text(__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat())
                private = Path(temp, 'update.env'); private.write_text('TM_DB_URL="fixture"\nUSPTO_API_KEY=\'fixture\'')
                trace = Path(temp, 'trace.txt')
                quote = lambda s: "'" + str(s).replace("'", "''") + "'"
                harness = Path(temp, 'run.ps1')
                harness.write_text(f'''
function cmd {{ if ($env:TM_DB_URL -ne 'fixture' -or $env:USPTO_API_KEY -ne 'fixture') {{ throw 'quoted env not unwrapped' }}; 'us' | Add-Content {quote(trace)}; $global:LASTEXITCODE = {us} }}
function node {{
  if (($args -join ' ') -like '*setup health*') {{ 'health' | Add-Content {quote(trace)}; $global:LASTEXITCODE={health} }}
  else {{ 'scan' | Add-Content {quote(trace)}; $global:LASTEXITCODE={scan} }}
}}
function python {{ 'backup' | Add-Content {quote(trace)}; $global:LASTEXITCODE={dump} }}
& {quote(ROOT / 'scripts/selfhost-windows/Invoke-TrademarkUpdate.ps1')} -RepoDir {quote(ROOT)} -EnvFile {quote(private)} -PythonExe python -BackupTarget {quote(Path(temp, 'backup'))} -WorkDir {quote(work)}
exit $LASTEXITCODE
''', encoding='utf-8')
                result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(harness)], capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, expected, result.stderr)
                stages = trace.read_text().splitlines()
                if us or health:
                    self.assertNotIn('backup', stages)
                if us or health or dump:
                    self.assertNotIn('scan', stages)
                else:
                    self.assertLess(stages.index('backup'), stages.index('scan'))

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell sandbox')
    def test_keeper_default_loopback_and_absolute_node(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp, 'repo')
            for relative in ('node_modules/next/dist/bin/next', '.next/BUILD_ID', '.env.local'):
                target = repo / relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('fixture')
            output = Path(temp, 'start.txt')
            quote = lambda s: "'" + str(s).replace("'", "''") + "'"
            harness = Path(temp, 'keeper.ps1')
            harness.write_text(f'''
function Get-NetTCPConnection {{ return $null }}
function Start-Sleep {{}}
function Invoke-WebRequest {{ return @{{StatusCode=200}} }}
function Start-Process {{ param($FilePath,$WorkingDirectory,$WindowStyle,$ArgumentList,$RedirectStandardOutput,$RedirectStandardError)
  "$FilePath|$WindowStyle|$($ArgumentList -join ' ')" | Set-Content {quote(output)}
}}
& {quote(ROOT / 'scripts/selfhost-windows/Invoke-TrademarksApiKeeper.ps1')} -RepoDir {quote(repo)} -NodeExe 'C:/fixture/node.exe' -LogPath {quote(Path(temp, 'logs/keeper.log'))}
exit $LASTEXITCODE
''', encoding='utf-8')
            result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(harness)], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            start = output.read_text()
            self.assertIn('C:/fixture/node.exe|Hidden|', start)
            self.assertIn('start -p 3000 -H 127.0.0.1', start)


if __name__ == '__main__':
    unittest.main()
