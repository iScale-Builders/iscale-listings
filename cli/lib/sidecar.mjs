// Design info from a JSON sidecar, so `iscale listing generate` does not have to
// re-read the image when the design is already described.
//
// The sidecar has the image's exact name: design.png -> design.json (or
// design.png.json), in the same folder. No other JSON is ever used or written, so a
// listing can never pick up another design's file. Sidecars are not standard inside:
// every tool writes its own shape, so this walks the JSON for fields that DESCRIBE THE DESIGN by common names,
// wherever they are nested, and ignores listing / product / price / marketplace
// sections (an old title or a product colour list is not a description of the art).
//
// A sidecar is used only when it has real design info AND says what text is on the
// design (or that there is none): that text is screened for trademarks and must be
// exact. Generation prompts / briefs say what was ASKED for, not what came out, so
// they never count on their own. Anything less: read the image as before.

import fs from 'node:fs';
import path from 'node:path';

const MAX_SIDECAR_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

// Sections that describe a listing, product setup, sales or bookkeeping, not the artwork.
const SKIP_SECTIONS = new Set([
  'listing', 'listings', 'market', 'intake', 'products', 'product', 'productcolors', 'productsettings', 'prices', 'price',
  'automation', 'upload', 'uploads', 'publish', 'sales', 'sold', 'ours', 'review', 'gate', 'generator', 'vector', 'vectors',
  'mockups', 'isolation', 'source', 'risk', 'confidence', 'generationnotes', 'listingmetadata', 'seo', 'amazon', 'etsy',
  'iscalelistings', 'shopify', 'redbubble', 'pinterest', 'marketplace', 'marketplaces', 'exclusion', 'excluded', 'excludedelements', 'negativeprompt',
]);

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// Field names (normalized) per design-info slot.
const SLOTS = {
  text: ['detectedtext', 'text', 'texts', 'designtext', 'textondesign', 'printedtext', 'visibletext', 'phrase', 'phrases', 'slogan', 'quote', 'wording', 'lettering', 'textcontent'],
  elements: ['visualelements', 'elements', 'objects', 'characters', 'subjects', 'subject', 'symbols', 'focalelements', 'motifs', 'items', 'illustrations', 'graphics', 'icons'],
  scene: ['scene', 'designdescription', 'description', 'imagedescription', 'artworkdescription', 'summary', 'composition', 'layout'],
  style: ['style', 'artstyle', 'styles', 'aesthetic', 'eraaesthetic', 'fontstyle', 'typography'],
  mood: ['mood', 'emotion', 'emotions', 'tone', 'vibe', 'humortype', 'colormood'],
  colors: ['colors', 'colours', 'primarycolors', 'palette', 'designcolors', 'colorpalette'],
  themes: ['niches', 'niche', 'themes', 'theme', 'topics', 'audience', 'occasion', 'occasions', 'tags', 'keywordsdesign'],
};
const SLOT_OF = new Map(Object.entries(SLOTS).flatMap(([slot, keys]) => keys.map((k) => [k, slot])));
// "There is no text on this design" signals.
const NO_TEXT_KEYS = new Set(['textdominance', 'textlayout', 'hastext', 'containstext']);
const NONE = new Set(['', 'none', 'no', 'false', 'n/a', 'na', 'not_applicable', 'notapplicable']);

const strings = (v) => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' ? (x.trim() ? [x.trim()] : []) : x && typeof x === 'object' ? strings(x.text ?? x.value ?? x.name ?? '') : []));
  return [];
};

/** Pull design info out of any JSON shape. Returns null when it has none worth using. */
export function designInfoFromJson(json) {
  const found = { text: [], elements: [], scene: [], style: [], mood: [], colors: [], themes: [] };
  let textKnown = false;
  const fieldsUsed = new Set();
  const walk = (node, trail, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const k = norm(key);
      if (SKIP_SECTIONS.has(k)) continue;
      const where = [...trail, key].join('.');
      if (NO_TEXT_KEYS.has(k)) {
        const v = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? '').toLowerCase();
        if ((k === 'hastext' || k === 'containstext') ? v === 'no' || v === 'false' : NONE.has(v)) {
          textKnown = true;
          fieldsUsed.add(where);
        }
        continue;
      }
      const slot = SLOT_OF.get(k);
      // "colors" as an object is a product colour profile, not the art's palette.
      if (slot && (typeof value === 'string' || Array.isArray(value))) {
        const vals = strings(value).filter((s) => !(slot !== 'text' && NONE.has(s.toLowerCase())));
        if (slot === 'text') {
          textKnown = true; // an explicit text field, even empty, says what the text is
          fieldsUsed.add(where);
        }
        if (vals.length) {
          found[slot].push(...vals);
          fieldsUsed.add(where);
        }
        continue;
      }
      if (value && typeof value === 'object') walk(value, [...trail, key], depth + 1);
    }
  };
  walk(json, [], 0);
  const uniq = (a) => [...new Map(a.map((s) => [s.toLowerCase(), s])).values()];
  for (const slot of Object.keys(found)) found[slot] = uniq(found[slot]);
  const describesArt = found.elements.length > 0 || found.scene.some((s) => s.length >= 20);
  if (!describesArt) return { usable: false, reason: 'no description of the artwork (objects, characters, scene)' };
  if (!textKnown) return { usable: false, reason: 'does not say what text is on the design' };
  return {
    usable: true,
    fieldsUsed: [...fieldsUsed],
    analysis: {
      visualElements: found.elements,
      detectedText: found.text,
      mood: found.mood.join(', '),
      style: found.style.join(', '),
      colors: found.colors,
      ...(found.scene.length ? { scene: found.scene.join(' ') } : {}),
      ...(found.themes.length ? { themes: found.themes } : {}),
      rawResponse: '',
    },
  };
}

/** The image's own sidecar, by exact name: <name>.json, then <name>.<ext>.json. Same folder only. */
export function sidecarCandidates(imagePath) {
  const abs = path.resolve(imagePath);
  const dir = path.dirname(abs);
  const file = path.basename(abs);
  const base = file.replace(IMAGE_EXT, '');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Case-insensitive like Windows/macOS file systems, but otherwise the exact name.
  const lower = new Map(entries.filter((e) => /\.json$/i.test(e)).map((e) => [e.toLowerCase(), e]));
  const out = [];
  for (const want of [`${base}.json`, `${file}.json`]) {
    const hit = lower.get(want.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.map((name) => path.join(dir, name));
}

/**
 * Find design info for an image. Never throws.
 * @returns {{ analysis?: object, file?: string, fieldsUsed?: string[], checked: { file: string, reason: string }[] }}
 */
export function findDesignInfo(imagePath) {
  const checked = [];
  for (const file of sidecarCandidates(imagePath)) {
    let json;
    try {
      if (fs.statSync(file).size > MAX_SIDECAR_BYTES) {
        checked.push({ file, reason: 'too large' });
        continue;
      }
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      checked.push({ file, reason: 'not valid JSON' });
      continue;
    }
    const info = designInfoFromJson(json);
    if (info.usable) return { analysis: info.analysis, file, fieldsUsed: info.fieldsUsed, checked };
    checked.push({ file, reason: info.reason });
  }
  return { checked };
}

// ---------------------------------------------------------------------------
// Saving the generated listing back into the design's JSON.
// ---------------------------------------------------------------------------

export const LISTING_SECTION = 'iscale_listings';

/**
 * Which JSON gets the listing: the sidecar the design info came from, else the image's
 * own exact-name sidecar. No sidecar: null (nothing is created).
 */
export function sidecarWriteTarget(imagePath, usedFile) {
  if (usedFile) return { file: usedFile, exists: true };
  const own = sidecarCandidates(imagePath)[0];
  return own ? { file: own, exists: true } : null;
}

/** Writes `record` under the `iscale_listings` key; every other field is kept as it was. */
export function saveListingToSidecar(file, record) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${path.basename(file)} is not a JSON object; listing not saved into it`);
  json[LISTING_SECTION] = record;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}
