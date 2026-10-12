import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = new URL('../../scripts/refresh-and-scan.ps1', import.meta.url);
const windows = process.platform === 'win32' ? describe : describe.skip;
windows('refresh wrapper fail-closed sandbox (native calls shadowed)', () => {
  it.each([
    { us: 7, eu: 0, health: 0, scan: 0, exit: 7, scanCalls: 0 },
    { us: 0, eu: 9, health: 0, scan: 0, exit: 9, scanCalls: 0 },
    { us: 0, eu: 0, health: 3, scan: 0, exit: 3, scanCalls: 0 },
    { us: 0, eu: 0, health: 0, scan: 3, exit: 3, scanCalls: 1 },
    { us: 0, eu: 0, health: 0, scan: 2, exit: 2, scanCalls: 1 },
    { us: 0, eu: 0, health: 0, scan: 0, writer: 1, exit: 1, scanCalls: 1 },
    { us: 0, eu: 0, health: 0, scan: 2, writer: 1, exit: 1, scanCalls: 1 },
    { us: 0, eu: 0, health: 0, scan: 3, writer: 1, exit: 3, scanCalls: 1 },
    { us: 0, eu: 0, health: 0, scan: 2, progress: true, exit: 2, scanCalls: 1 },
  ])('keeps stage failures/status for $us/$eu/$health/$scan', fixture => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-refresh-test-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, '.env.local'), '');
      fs.copyFileSync(source, path.join(root, 'scripts', 'refresh.ps1'));
      const trace = path.join(root, 'trace.jsonl');
      const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
      const script = `
function python { $call = $args -join ' '; @{binary='python';call=$call}|ConvertTo-Json -Compress|Add-Content ${quote(trace)}; $global:LASTEXITCODE = if($call -like '*backfill*'){${fixture.us}}else{${fixture.eu}} }
function node { $call = $args -join ' '; @{binary='node';call=$call}|ConvertTo-Json -Compress|Add-Content ${quote(trace)}; if($call -like '*listings scan*' -and ${fixture.progress ? '$true' : '$false'}) { Write-Error 'sandbox progress diagnostic' }; $global:LASTEXITCODE = if($call -like '*setup health*'){${fixture.health}}elseif($call -like '*listings scan*'){${fixture.scan}}else{${fixture.writer ?? 0}} }
. ${quote(path.join(root, 'scripts', 'refresh.ps1'))} -Euipo
exit $LASTEXITCODE
`;
      const harness = path.join(root, 'run.ps1'); fs.writeFileSync(harness, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      expect(result.status, result.stderr).toBe(fixture.exit);
      const calls = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
      const scans = calls.filter(row => row.binary === 'node' && row.call.includes('listings scan'));
      expect(scans).toHaveLength(fixture.scanCalls);
      if (scans.length) expect(scans[0].call).toContain('--include-description');
      expect(calls.some(row => row.call.includes('write-refresh-receipt.mjs'))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const shellTests = fs.existsSync(gitBash) ? describe : describe.skip;
shellTests('Bash refresh receipt failure sandbox (all import/API calls shadowed)', () => {
  it.each([
    { us: 7, health: 0, scan: 0, writer: 0, exit: 7, scans: 0 },
    { us: 0, health: 3, scan: 0, writer: 0, exit: 3, scans: 0 },
    { us: 0, health: 0, scan: 0, writer: 1, exit: 1, scans: 1 },
    { us: 0, health: 0, scan: 2, writer: 1, exit: 1, scans: 1 },
    { us: 0, health: 0, scan: 3, writer: 1, exit: 3, scans: 1 },
  ])('keeps $us/$health/$scan/$writer status without false success', fixture => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-bash-refresh-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, '.env.local'), '');
      fs.copyFileSync(new URL('../../scripts/refresh-and-scan.sh', import.meta.url), path.join(root, 'scripts', 'refresh.sh'));
      const trace = path.join(root, 'trace.txt').replaceAll('\\', '/');
      const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      const harness = `
python3() { printf 'python:%s\\n' "$*" >> ${shellQuote(trace)}; case "$*" in *backfill*) return ${fixture.us};; *) return 0;; esac; }
node() { printf 'node:%s\\n' "$*" >> ${shellQuote(trace)}; case "$*" in *'setup health'*) return ${fixture.health};; *'listings scan'*) return ${fixture.scan};; *) return ${fixture.writer};; esac; }
export -f python3 node
bash ${shellQuote(path.join(root, 'scripts', 'refresh.sh').replaceAll('\\', '/'))} --euipo
`;
      const result = spawnSync(gitBash, ['--noprofile', '--norc', '-c', harness], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      expect(result.status, result.stderr).toBe(fixture.exit);
      const calls = fs.readFileSync(trace, 'utf8').split(/\r?\n/);
      expect(calls.filter(line => line.includes('listings scan'))).toHaveLength(fixture.scans);
      expect(calls.some(line => line.includes('write-refresh-receipt.mjs'))).toBe(true);
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('iscale-bash-refresh-')) throw new Error('Cleanup ownership mismatch');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('actual sanitized refresh receipt writer', () => {
  it.each([{ scan: '2', complete: true }, { scan: '3', complete: false }])('reports scan exit $scan coverage truthfully', fixture => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-receipt-test-'));
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/write-refresh-receipt.mjs', import.meta.url)), '0', '0', '0', fixture.scan], { env: { ...process.env, ISCALE_HOME: root }, encoding: 'utf8', windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'refresh-and-scan-last.json'), 'utf8'));
      expect(receipt.coverageComplete).toBe(fixture.complete); expect(receipt.incomplete).toBe(!fixture.complete); expect(receipt.status).toBe(fixture.complete ? 'completed' : 'failed');
    } finally { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Cleanup ownership mismatch'); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
