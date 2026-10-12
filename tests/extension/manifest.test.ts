import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  manifest_version?: number;
  version?: string;
  description?: string;
  icons?: Record<string, string>;
}

const repoRoot = process.cwd();
const extensionRoot = path.join(repoRoot, 'extension');
const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')
) as ExtensionManifest;

describe('Chrome Web Store manifest constraints', () => {
  it('uses Manifest V3 and a valid release version', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the store summary within Chrome\'s 132-character limit', () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.description!.length).toBeLessThanOrEqual(132);
  });

  it.each(['16', '32', '48', '128'])('ships the required %spx icon', (size) => {
    const relativePath = manifest.icons?.[size];
    expect(relativePath).toBeTruthy();
    expect(() => readFileSync(path.join(extensionRoot, relativePath!))).not.toThrow();
  });
});
