import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PYTHON } from '../helpers/python';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('safe_zip.extract_suffixed_members', () => {
  it('extracts a normal xml member and refuses zip-slip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-safe-zip-'));
    const script = `
import sys, zipfile
from pathlib import Path
sys.path.insert(0, r${JSON.stringify(path.join(repoRoot, 'scripts'))})
from safe_zip import extract_suffixed_members
dest = Path(r${JSON.stringify(dir)}) / 'out'
dest.mkdir()
good = dest / 'good.zip'
with zipfile.ZipFile(good, 'w') as zf:
    zf.writestr('mark.xml', '<ok/>')
paths = extract_suffixed_members(good, dest, '.xml')
assert paths and paths[0].name == 'mark.xml'
assert (dest / 'mark.xml').is_file()
bad = dest / 'bad.zip'
with zipfile.ZipFile(bad, 'w') as zf:
    zf.writestr('../evil.xml', '<nope/>')
try:
    extract_suffixed_members(bad, dest, '.xml')
except RuntimeError as exc:
    assert 'Unsafe ZIP entry' in str(exc)
else:
    raise SystemExit('expected zip-slip to fail')
assert not (dest.parent / 'evil.xml').exists()
print('ok')
`;
    const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });
});
