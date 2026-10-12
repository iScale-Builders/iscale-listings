import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { PYTHON } from '../helpers/python';

const repoRoot = process.cwd();

function loadPythonClassification() {
  const snippet = String.raw`
import json
import sys
sys.path.insert(0, "scripts")
from uspto_mark_types import classify_mark_drawing_code, is_screenable_mark_drawing_code

codes = ["1", "2", "3", "4", "5", "6", "", "99"]
print(json.dumps({
    code: {
        "label": classify_mark_drawing_code(code),
        "screenable": is_screenable_mark_drawing_code(code),
    }
    for code in codes
}))
`;
  const result = spawnSync(PYTHON, ['-c', snippet], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, { label: string; screenable: boolean }>;
}

describe('USPTO mark drawing codes', () => {
  it('screens every code with literal wording and excludes non-text marks', () => {
    expect(loadPythonClassification()).toEqual({
      '1': { label: 'typeset', screenable: true },
      '2': { label: 'design only', screenable: false },
      '3': { label: 'words and design', screenable: true },
      '4': { label: 'standard character', screenable: true },
      '5': { label: 'stylized text', screenable: true },
      '6': { label: 'non-visual', screenable: false },
      '': { label: 'unknown', screenable: false },
      '99': { label: 'unknown', screenable: false },
    });
  });

  it('keeps the importer and both matching RPCs on the canonical labels', () => {
    const importer = fs.readFileSync(path.join(repoRoot, 'scripts/tm_splitter_adapted.py'), 'utf8');
    const migration = fs.readFileSync(
      path.join(repoRoot, 'supabase/migrations/008_include_uspto_literal_special_form_marks.sql'),
      'utf8'
    );

    expect(importer).toContain('classify_mark_drawing_code(drawing_code)');
    expect(importer).toContain('SCREENABLE_MARK_TYPES');
    expect(migration.match(/'words and design'/g)).toHaveLength(2);
    expect(migration.match(/'stylized text'/g)).toHaveLength(2);
    expect(migration).not.toContain("'text'");
  });
});
