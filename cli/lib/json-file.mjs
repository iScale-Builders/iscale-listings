// Read a JSON file the way people actually produce them: tolerate the UTF-8 byte
// order mark Windows tools (PowerShell, Notepad) add, and turn "file not found" /
// "not JSON" into a message a person can act on.

import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile(file, what = 'file') {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') throw new Error(`Can't find ${what}: ${abs}`);
    throw new Error(`Can't read ${what} ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${abs} is not a JSON file (expected the ${what}).`);
  }
}
