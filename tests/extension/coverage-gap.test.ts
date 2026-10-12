import { describe, it, expect } from 'vitest';
import { uncheckedJurisdictions } from '@/extension/shared';
import { readJsonBody } from '@/lib/errors';
import { splitLongPhrase } from '@/extension/scan-core';

describe('long page text is screened in pieces, not skipped', () => {
  it('keeps short text as-is', () => {
    expect(splitLongPhrase('Just Do It')).toEqual({ pieces: ['Just Do It'], dropped: false });
  });

  it('splits a long bullet at sentence boundaries so every piece is screened', () => {
    const long = `${'Soft cotton fabric for all day comfort. '.repeat(4)}Perfect Just Do It gift for runners.`;
    const { pieces, dropped } = splitLongPhrase(long, 60);
    expect(dropped).toBe(false);
    expect(pieces.every((p) => p.length <= 60)).toBe(true);
    expect(pieces.join(' ')).toContain('Just Do It');
  });

  it('falls back to word windows when there is no punctuation', () => {
    const { pieces } = splitLongPhrase(Array(50).fill('word').join(' ') + ' nike', 40);
    expect(pieces.every((p) => p.length <= 40)).toBe(true);
    expect(pieces.at(-1)).toContain('nike');
  });
});

describe('extension coverage gap (D-01/D-04)', () => {
  it('reports nothing missing when every requested jurisdiction was searched', () => {
    expect(uncheckedJurisdictions({ jurisdictions_checked: ['US', 'EUIPO'] }, ['US', 'EUIPO'])).toEqual([]);
  });

  it('reports a silently dropped jurisdiction', () => {
    expect(uncheckedJurisdictions({ jurisdictions_checked: ['US'] }, ['US', 'EUIPO'])).toEqual(['EUIPO']);
  });

  it('treats an empty or missing jurisdictions_checked as nothing searched', () => {
    expect(uncheckedJurisdictions({ jurisdictions_checked: [] }, ['US', 'EUIPO'])).toEqual(['US', 'EUIPO']);
    expect(uncheckedJurisdictions({}, ['US', 'EUIPO'])).toEqual(['US', 'EUIPO']);
  });
});

describe('readJsonBody (D-03)', () => {
  it('returns 400 INVALID_JSON for a malformed body instead of a 500', async () => {
    const result = await readJsonBody(
      new Request('http://localhost/api/v1/check', { method: 'POST', body: '{not json' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.code).toBe('INVALID_JSON');
  });

  it('parses a valid body', async () => {
    const result = await readJsonBody(
      new Request('http://localhost/api/v1/check', { method: 'POST', body: '{"text":"cat"}' })
    );
    expect(result).toEqual({ ok: true, body: { text: 'cat' } });
  });
});
