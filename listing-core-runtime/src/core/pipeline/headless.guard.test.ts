// Architectural guard: the shared core MUST stay headless. If business logic can
// only run in the browser, the CLI can't reach it — and a "feature" silently
// lands on one surface only. This fails the build the moment any core source
// touches a browser/DOM global or imports the extension, so the "logic lives in
// core, both surfaces are thin callers" rule is machine-enforced, not a promise.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Browser/DOM globals accessed as `name.` or `name[` (so the words appearing in
// comments or as plain string data — e.g. 'chrome' in the forbidden-words list —
// don't trip the guard).
const FORBIDDEN_GLOBALS = ['document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'chrome'];
const accessRe = new RegExp(`\\b(${FORBIDDEN_GLOBALS.join('|')})\\s*[.\\[]`);
// Any import that reaches into the extension (which IS allowed to touch the DOM).
const extensionImportRe = /\bfrom\s+['"][^'"]*\/extension\b/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('core headless guard', () => {
  const files = collectTsFiles(coreDir);

  it('finds core source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no core source touches a browser/DOM global', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const m = src.match(accessRe);
      if (m) offenders.push(`${path.relative(coreDir, file)} → "${m[0]}"`);
    }
    expect(offenders, `core must stay headless; offenders:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no core source imports the extension', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (extensionImportRe.test(src)) offenders.push(path.relative(coreDir, file));
    }
    expect(offenders, `core must not import the extension; offenders:\n${offenders.join('\n')}`).toEqual([]);
  });
});
