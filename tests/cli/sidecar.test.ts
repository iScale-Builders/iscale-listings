import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { designInfoFromJson, findDesignInfo, saveListingToSidecar, sidecarCandidates, sidecarWriteTarget } from '@/cli/lib/sidecar.mjs';

// Real shapes seen in the wild (trimmed): a design-analysis record, an uploader's
// settings sidecar (no design info) and a generation brief (intent, not the result).
const designRecord = {
  schema_version: '2.1',
  source: { filename: 'production_original.png', width: 4500 },
  data: {
    content: { text: [], objects: ['cigarette'], characters: ['man'], symbols: [], scene: "A tightly cropped man's face turned toward the left with a cigarette", focal_elements: ['man', 'cigarette'] },
    design: { layout: 'asymmetric close-up portrait', text_dominance: 'none' },
    style: { art_style: ['distressed_grunge', 'vintage_retro'], font_style: ['none'], primary_colors: ['cream', 'black'], color_mood: 'neutral', era_aesthetic: ['vintage'] },
    theme: { niches: ['smoking'], audience: ['fans of vintage smoker portraits'], emotion: ['edgy', 'nostalgic'], humor_type: ['none'] },
    risk: { notes: 'no brand visible', detected_brands: [] },
    generation_notes: { reusable_prompt: 'Create a raster PNG of a smoker portrait' },
    tags: ['smoking', 'abstract portrait'],
  },
  market: { listing: { title: 'Raucher Mann Vintage Smoker Portrait', description: 'old listing text should never count' } },
  intake: { title: 'old title', context: { element_tags: ['x'] } },
};
const uploaderSidecar = {
  record_type: 'upload_sidecar',
  source_image: 'my_design.png',
  colors: { profile: 'all', activeProfile: 1 },
  listing: { title: 'Abstract Illustrated Graphic Design', bullets: ['Original bold artwork'], keywords: ['graphic tee'] },
  products: { STANDARD_TSHIRT: { colors: ['black', 'navy'], prices: { '.com': '19.99' } } },
  productColors: { MUG: ['white'] },
};
const generationBrief = {
  id: 'birthday-1',
  generation_brief: 'Create a playful kids fourth birthday t-shirt design with bold lettering "FOUR"',
  palette_direction: 'black, white, red',
  composition_notes: 'Preserve the source composition',
  excluded_elements: ['Garment mockup body'],
};

describe('design info from any sidecar shape', () => {
  it('reads a rich design record and ignores listing / market / risk sections', () => {
    const r = designInfoFromJson(designRecord);
    expect(r.usable).toBe(true);
    const a = r.analysis!;
    expect(a.detectedText).toEqual([]);
    expect(a.visualElements).toEqual(expect.arrayContaining(['cigarette', 'man']));
    expect(a.colors).toEqual(['cream', 'black']);
    expect(a.mood).toContain('edgy');
    expect(a.style).toContain('distressed_grunge');
    expect(a.scene).toContain('cigarette');
    expect(a.themes).toEqual(expect.arrayContaining(['smoking', 'fans of vintage smoker portraits']));
    expect(JSON.stringify(r.analysis)).not.toMatch(/Raucher|old listing|old title|reusable|brand visible/);
  });

  it('an uploader settings sidecar has no design info (product colours and old listings do not count)', () => {
    expect(designInfoFromJson(uploaderSidecar)).toMatchObject({ usable: false, reason: expect.stringMatching(/no description/) });
  });

  it('a generation brief is intent, not the finished design', () => {
    expect(designInfoFromJson(generationBrief).usable).toBe(false);
  });

  it('a simple hand-written sidecar works', () => {
    const r = designInfoFromJson({ description: 'A grumpy cat holding a steaming coffee cup', text: 'Monday Mood', style: 'cartoon', colors: ['orange', 'brown'] });
    expect(r).toMatchObject({ usable: true, analysis: { detectedText: ['Monday Mood'], style: 'cartoon', colors: ['orange', 'brown'], scene: 'A grumpy cat holding a steaming coffee cup' } });
  });

  it("iscale's own output shape works (visualElements / detectedText)", () => {
    const r = designInfoFromJson({ fields: [], analysis: { visualElements: ['cat'], detectedText: ['Cat Dad'], mood: 'funny', style: 'cartoon', colors: ['orange'] } });
    expect(r).toMatchObject({ usable: true, analysis: { visualElements: ['cat'], detectedText: ['Cat Dad'] } });
  });

  it('without a word on what text the design has, read the image instead', () => {
    expect(designInfoFromJson({ objects: ['cat', 'coffee cup'], style: 'cartoon' })).toMatchObject({ usable: false, reason: expect.stringMatching(/text/) });
  });

  it('"no text" signals count as knowing the text', () => {
    expect(designInfoFromJson({ objects: ['mountain'], has_text: false }).usable).toBe(true);
    expect(designInfoFromJson({ objects: ['mountain'], text_layout: 'none' }).usable).toBe(true);
  });
});

describe('finding the sidecar next to the image', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-sidecar-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));

  it('only the exact name counts: <name>.json, then <name>.png.json', () => {
    put('My_Design.png', 'png');
    put('other.png', 'png');
    put('my-design.json', {});
    put('my_design.png.json', {});
    put('my_design.json', {});
    put('design.json', {});
    put('batch.json', { files: ['My_Design.png'] });
    expect(sidecarCandidates(path.join(dir, 'My_Design.png')).map((p) => path.basename(p))).toEqual(['my_design.json', 'my_design.png.json']);
  });

  it("never picks up another design's JSON (audit 2026-10-07 reproduction)", () => {
    for (const f of ['design.png', 'design-2.png', 'design-1.png', 'batch-a.png', 'batch-b.png']) put(f, 'png');
    put('design-2.json', designRecord);
    put('design-10.json', designRecord);
    put('metadata.json', designRecord);
    put('design.json.bak', designRecord);
    for (const img of ['design.png', 'design-1.png', 'batch-a.png', 'batch-b.png']) {
      expect(findDesignInfo(path.join(dir, img))).toEqual({ checked: [] });
      expect(sidecarWriteTarget(path.join(dir, img), null)).toBeNull();
    }
    expect(path.basename(findDesignInfo(path.join(dir, 'design-2.png')).file!)).toBe('design-2.json');
  });

  it('uses the first exact-name sidecar with design info and reports the one it skipped', () => {
    put('production_original.png', 'png');
    put('production_original.json', uploaderSidecar);
    put('production_original.png.json', designRecord);
    const r = findDesignInfo(path.join(dir, 'production_original.png'));
    expect(path.basename(r.file!)).toBe('production_original.png.json');
    expect(r.checked).toEqual([{ file: path.join(dir, 'production_original.json'), reason: expect.stringMatching(/no description/) }]);
    expect((r.analysis as { visualElements: string[] }).visualElements).toContain('cigarette');
  });

  it('falls back to the image when no sidecar has design info (or none exists, or it is broken)', () => {
    put('a.png', 'png');
    expect(findDesignInfo(path.join(dir, 'a.png'))).toEqual({ checked: [] });
    put('a.json', '{not json');
    expect(findDesignInfo(path.join(dir, 'a.png'))).toMatchObject({ checked: [{ reason: 'not valid JSON' }] });
    put('a.json', '\uFEFF' + JSON.stringify(generationBrief));
    expect(findDesignInfo(path.join(dir, 'a.png')).analysis).toBeUndefined();
  });

  it('only looks in the image folder', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    put('design.json', designRecord);
    fs.writeFileSync(path.join(dir, 'sub', 'x.png'), 'png');
    expect(findDesignInfo(path.join(dir, 'sub', 'x.png')).analysis).toBeUndefined();
  });
});

describe('saving the listing into the design JSON', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-save-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const record = { listing: { title: 'Cat Dad Funny Cat' }, keywords: ['cat dad', 'funny cat'], tags: ['cat dad', 'funny cat'] };

  it('writes into the sidecar the design info came from, keeping every other field', () => {
    put('design.json', designRecord);
    const file = path.join(dir, 'design.json');
    expect(sidecarWriteTarget(path.join(dir, 'production_original.png'), file)).toEqual({ file, exists: true });
    saveListingToSidecar(file, record);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.iscale_listings).toEqual(record);
    expect(saved.data).toEqual(designRecord.data);
    expect(saved.market).toEqual(designRecord.market);
  });

  it("writes into the image's own sidecar even when it had no design info", () => {
    put('my_design.png', 'png');
    put('my_design.json', uploaderSidecar);
    expect(sidecarWriteTarget(path.join(dir, 'my_design.png'), null)).toEqual({ file: path.join(dir, 'my_design.json'), exists: true });
  });

  it('no sidecar: nothing is created, and a batch file is never written to', () => {
    put('cat.png', 'png');
    put('batch.json', { files: ['cat.png', 'dog.png'] });
    expect(sidecarWriteTarget(path.join(dir, 'cat.png'), null)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'cat.json'))).toBe(false);
  });

  it('a saved listing is not mistaken for design info on the next run', () => {
    const saved = { iscale_listings: { ...record, fields: [{ id: 'title', content: 'x' }], design_info: { source: 'image' } } };
    expect(designInfoFromJson(saved).usable).toBe(false);
    const both = { ...designRecord, ...saved };
    expect(designInfoFromJson(both).analysis!.themes).not.toContain('cat dad');
  });

  it('refuses to write into a JSON that is not an object', () => {
    put('list.json', [1, 2]);
    expect(() => saveListingToSidecar(path.join(dir, 'list.json'), record)).toThrow(/not a JSON object/);
  });
});
