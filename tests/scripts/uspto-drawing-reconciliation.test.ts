import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { PYTHON } from '../helpers/python';

const repoRoot = process.cwd();

function runPython(code: string) {
  return spawnSync(PYTHON, ['-c', code], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('USPTO drawing-code reconciliation', () => {
  it('builds a current code-3/code-5 stage by replaying daily changes', () => {
    const snippet = String.raw`
import json
import sys
import tempfile
import zipfile
from pathlib import Path
sys.path.insert(0, "scripts")
from stage_uspto_drawing_reconciliation import connect_state, process_zip, stage_summary

def case(serial, code, wordmark, classes):
    class_xml = "".join(
        f"<classification><international-code>{value}</international-code></classification>"
        for value in classes
    )
    return f"""<case-file>
      <serial-number>{serial}</serial-number>
      <case-file-header>
        <mark-identification>{wordmark}</mark-identification>
        <mark-drawing-code>{code}</mark-drawing-code>
        <status-code>700</status-code>
        <filing-date>20250101</filing-date>
      </case-file-header>
      <classifications>{class_xml}</classifications>
    </case-file>"""

def write_zip(path, cases):
    xml = "<trademark-applications-daily>" + "".join(cases) + "</trademark-applications-daily>"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("records.xml", xml)

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    annual = root / "annual.zip"
    daily = root / "daily.zip"
    write_zip(annual, [
        case("10000001", "3", "WORDS WITH DESIGN", ["025"]),
        case("10000002", "2", "DESIGN ONLY", ["025"]),
        case("10000003", "5", "STYLIZED WORDS", ["025", "035"]),
        case("10000004", "4", "STANDARD WORDS", ["025"]),
    ])
    write_zip(daily, [
        case("10000001", "2", "NOW DESIGN ONLY", ["025"]),
        case("10000003", "5", "STYLIZED WORDS UPDATED", ["035"]),
        case("10000005", "3", "NEW WORDS WITH DESIGN", ["025"]),
    ])
    conn = connect_state(root / "stage.sqlite3")
    process_zip(conn, annual, "annual", "2025-12-31", parser_backend="stdlib")
    annual_rows = conn.execute(
        "SELECT serial_number, international_class, mark_drawing_type "
        "FROM stage_records ORDER BY serial_number, international_class"
    ).fetchall()
    process_zip(conn, daily, "daily", "2026-01-02", parser_backend="stdlib")
    final_rows = conn.execute(
        "SELECT serial_number, international_class, mark_drawing_type, wordmark "
        "FROM stage_records ORDER BY serial_number, international_class"
    ).fetchall()
    print(json.dumps({
        "annual": [list(row) for row in annual_rows],
        "final": [list(row) for row in final_rows],
        "summary": stage_summary(conn),
    }))
    conn.close()
`;
    const result = runPython(snippet);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      annual: [
        ['10000001', '025', 'words and design'],
        ['10000003', '025', 'stylized text'],
        ['10000003', '035', 'stylized text'],
      ],
      final: [
        ['10000003', '035', 'stylized text', 'STYLIZED WORDS UPDATED'],
        ['10000005', '025', 'words and design', 'NEW WORDS WITH DESIGN'],
      ],
      summary: {
        stage_complete: false,
        annual_cutoff: null,
        daily_through: null,
        record_count: 2,
        max_row_id: 5,
        records_by_type: {
          'stylized text': 1,
          'words and design': 1,
        },
        completed_files: {
          annual: 1,
          daily: 1,
        },
      },
    });
  });

  it('selects only the newest complete annual snapshot', () => {
    const snippet = String.raw`
import json
import sys
sys.path.insert(0, "scripts")
from stage_uspto_drawing_reconciliation import select_latest_annual_files

files = [
    {"fileName": "apc18840407-20241231-02.zip"},
    {"fileName": "apc18840407-20251231-02.zip"},
    {"fileName": "apc18840407-20251231-01.zip"},
]
cutoff, selected = select_latest_annual_files(files)
print(json.dumps({"cutoff": cutoff, "names": [item["fileName"] for item in selected]}))
`;
    const result = runPython(snippet);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cutoff: '2025-12-31',
      names: ['apc18840407-20251231-01.zip', 'apc18840407-20251231-02.zip'],
    });
  });

  it('requires explicit mutation confirmation and removes the stale RPC overload', () => {
    const applySource = fs.readFileSync(
      path.join(repoRoot, 'scripts/apply_uspto_drawing_reconciliation.py'),
      'utf8'
    );
    const migration = fs.readFileSync(
      path.join(repoRoot, 'supabase/migrations/009_remove_legacy_uspto_match_overload.sql'),
      'utf8'
    );

    expect(applySource).toContain('RECONCILE-USPTO-DRAWING-CODES');
    expect(applySource).toContain('backup_complete');
    expect(applySource).toContain('function_definitions');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.match_trademarks(TEXT[], TEXT[])');
    expect(migration).not.toContain("'text'");
  });

  it('retries the Windows atomic rename without discarding a complete download', () => {
    const stageSource = fs.readFileSync(
      path.join(repoRoot, 'scripts/stage_uspto_drawing_reconciliation.py'),
      'utf8'
    );

    expect(stageSource).toContain('for attempt in range(10)');
    expect(stageSource).toContain('except PermissionError');
    expect(stageSource).toContain('partial.replace(destination)');
  });
});
