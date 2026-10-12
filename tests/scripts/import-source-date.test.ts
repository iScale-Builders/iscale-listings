import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { PYTHON } from '../helpers/python';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function runPython(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: repoRoot,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeTempFile(name: string, content: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trademark-import-test-'));
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function writeZipFile(zipName: string, entryName: string, content: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trademark-import-test-'));
  const sourcePath = path.join(tempDir, entryName);
  const zipPath = path.join(tempDir, zipName);
  fs.writeFileSync(sourcePath, content, 'utf8');
  const result = spawnSync(
    'python',
    [
      '-c',
      'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n    archive.write(sys.argv[2], sys.argv[3])',
      zipPath,
      sourcePath,
      entryName,
    ],
    { cwd: repoRoot }
  );
  if (result.status !== 0) {
    throw new Error(`failed to create test zip: ${result.stderr.toString('utf8')}`);
  }
  return zipPath;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trademark-import-test-'));
}

describe('importer source freshness guards', () => {
  it('exposes npm import commands for the EU source', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['import:euipo']).toBe('python scripts/import_euipo.py');
    expect(packageJson.scripts['probe:euipo-search']).toBe(
      'python scripts/euipo_search_probe.py'
    );
  });

  it('rejects page-limited real EUIPO imports before loading Supabase credentials', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--page-limit',
      '1',
      '--source-updated-at',
      '2026-05-28',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--page-limit is only allowed with --dry-run');
    expect(output).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('rejects unsupported EUIPO page sizes before network or credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--page-size',
      '500',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--page-size must be between 1 and 100');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('rejects invalid EUIPO log intervals before credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--log-every',
      '0',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--log-every must be at least 1');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('rejects malformed EUIPO resume pages before credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--start-page',
      '25=0',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--start-page PAGE values are 1-based');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('rejects unknown EUIPO resume-page status filters before credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--start-page',
      '25:BOGUS=10',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('unknown --start-page status value: BOGUS');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('rejects invalid EUIPO retry settings before credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--retries',
      '-1',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--retries must not be negative');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('maps EUIPO status values into database-safe status codes', async () => {
    const result = await runPython([
      '-c',
      [
        'import sys',
        'sys.path.insert(0, "scripts")',
        'from import_euipo import map_status',
        'print(map_status("UNDER_EXAMINATION"))',
        'print(map_status("REGISTERED"))',
      ].join('; '),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("('LIVE', 'EXAM')");
    expect(result.stdout).toContain("('LIVE', 'REG')");
  });

  it('detects Supabase statement-timeout bodies and splits upsert batches', async () => {
    const result = await runPython([
      '-c',
      [
        'import sys',
        'from urllib.error import HTTPError',
        'from io import BytesIO',
        'sys.path.insert(0, "scripts")',
        'from import_euipo import (',
        '  DEFAULT_BATCH_SIZE, is_statement_timeout_body, split_upsert_batch,',
        '  upsert_batch, format_resume_hint, Config,',
        ')',
        'assert DEFAULT_BATCH_SIZE == 100',
        'timeout_body = \'{"code":"57014","message":"canceling statement due to statement timeout"}\'',
        'assert is_statement_timeout_body(timeout_body)',
        'assert not is_statement_timeout_body(\'{"code":"23505","message":"duplicate"}\')',
        'left, right = split_upsert_batch([{"n": i} for i in range(5)])',
        'assert len(left) == 2 and len(right) == 3',
        'calls = []',
        'def writer(config, records):',
        '  calls.append(len(records))',
        '  if len(records) > 2:',
        '    raise HTTPError("http://x", 500, "err", hdrs=None, fp=BytesIO(timeout_body.encode()))',
        'cfg = Config("id","secret","https://example.supabase.co","key","auth","api")',
        'records = [{"jurisdiction":"EUIPO","serial_number":str(i),"international_class":"025"} for i in range(5)]',
        'written = upsert_batch(cfg, records, dry_run=False, post_fn=writer)',
        'assert written == 5',
        'assert calls[0] == 5',
        'assert any(size < 5 for size in calls[1:])',
        'assert max(calls) == 5',
        'hint = format_resume_hint("2026-07-19", [9,18,20], 20, "APPLICATION_PUBLISHED", 1, 100)',
        'assert "--start-page 20:APPLICATION_PUBLISHED=1" in hint',
        'assert "--batch-size 25" in hint',
        'print("ok")',
      ].join('\n'),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('rejects EUIPO batch size below 1 before credential loading', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--batch-size',
      '0',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('--batch-size must be at least 1');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

  it('rejects unknown EUIPO status filters before network access', async () => {
    const result = await runPython([
      'scripts/import_euipo.py',
      '--since',
      '2026-05-28',
      '--classes',
      '25',
      '--statuses',
      'APPLICATION_UNDER_EXAMINATION',
      '--dry-run',
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('unknown EUIPO status value');
    expect(output).toContain('UNDER_EXAMINATION');
    expect(output).not.toContain('EUIPO_CLIENT_ID');
  });

});
