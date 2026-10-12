// `iscale listing generate` — the same pipeline the extension's Keywords tab
// runs (image → keywords → Amazon autosuggest → listing → trademark check and
// rewrite), with the AI calls going to the user's own subscription CLI and the
// prompt rules / fields / classes / banned words coming from shared settings.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCore } from './core-loader.mjs';
import { runEngine } from './engines.mjs';
import { DISCLAIMER } from './trademark.mjs';
import { findDesignInfo, saveListingToSidecar, sidecarWriteTarget } from './sidecar.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export async function imageToDataUrl(file) {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type "${path.extname(file) || '(none)'}" — use png, jpg, webp, or gif`);
  return `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
}

/** An AI transport that runs every core AI call through a subscription CLI. */
export function engineTransport({ engine, model, run = runEngine }) {
  return {
    chat: (_config, prompt) => run({ engine, model, prompt, timeoutSeconds: 180 }),
    vision: (_config, imageBase64, prompt) => run({ engine, model, prompt, imageBase64, timeoutSeconds: 300 }),
  };
}

/**
 * @param {{ imagePath: string, settings?: { config?: object } | null, engine: string, model?: string,
 *   trademark?: boolean, validate?: boolean, apiBase?: string, onPhase?: (phase: string) => void, run?: Function,
 *   readImage?: boolean }} opts
 */
export async function generateListing({ imagePath, settings, engine, model, trademark = true, validate = true, apiBase, onPhase, run, readImage = false }) {
  const core = await loadCore();
  // The design's JSON sidecar (it travels with the image) may already describe it.
  const sidecar = readImage ? { checked: [] } : findDesignInfo(imagePath);
  const designInfo = sidecar.analysis
    ? { source: 'sidecar', file: sidecar.file, fieldsUsed: sidecar.fieldsUsed }
    : { source: 'image', ...(readImage ? { reason: '--read-image' } : sidecar.checked.length ? { skipped: sidecar.checked } : { reason: 'no sidecar next to the image' }) };
  if (apiBase) core.setTrademarkApiBase(apiBase);
  const config = settings?.config ?? core.DEFAULT_LISTING_CONFIG;
  const result = await core.runListingPipeline(
    {
      imageBase64: sidecar.analysis ? '' : await imageToDataUrl(imagePath),
      ...(sidecar.analysis ? { analysis: sidecar.analysis } : {}),
      aiConfig: { provider: 'codex', apiKey: '', transport: engineTransport({ engine, model, run }) },
      config,
      validateEnabled: validate,
      trademarkEnabled: trademark,
    },
    { autosuggest: validate ? core.amazonAutosuggest : null, onPhase }
  );
  const final = result.trademark?.finalListing ?? {};
  const fields = result.listing.fields.map((f) => ({
    id: f.fieldId,
    name: f.fieldName,
    maxChars: f.maxChars,
    content: final[f.fieldId] ?? f.content,
  }));
  const trademarkStatus = !trademark
    ? 'skipped'
    : result.trademarkError
      ? 'unverified'
      : result.trademark?.stale
        ? 'unverified'
        : result.trademark?.clean
          ? 'clear'
          : 'risk';
  // Screen the keyword list too, like the extension does (its trademarked pills
  // turn red): only clean keywords are offered; flagged ones are listed apart.
  let keywords = result.validated.map((k) => k.word);
  let trademarkedKeywords = [];
  let keywordScreen = trademark ? 'done' : 'skipped';
  if (trademark && keywords.length) {
    try {
      const screened = await core.screenTermsForTrademarks(keywords, config.trademarkClasses, config.allowSingleWordTrademarks ?? true);
      trademarkedKeywords = [...screened.flagged].map(([keyword, m]) => ({
        keyword,
        wordmark: m.wordmark,
        jurisdiction: m.jurisdiction ?? 'US',
        registration_status: m.registration_status,
        serial_number: m.serial_number,
      }));
      const flagged = new Set(trademarkedKeywords.map((t) => t.keyword));
      keywords = keywords.filter((k) => !flagged.has(k));
      if (screened.stale) keywordScreen = 'unverified';
    } catch (e) {
      keywordScreen = 'unverified';
      onPhase?.(`keyword screen failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A mark the listing check took out of the copy must not survive in the keywords
  // (they double as tags): drop any keyword containing a flagged term.
  for (const m of result.trademark?.flaggedMarks ?? []) {
    const term = String(m.term ?? '').toLowerCase().trim();
    if (!term) continue;
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
    for (const k of keywords.filter((kw) => re.test(kw))) {
      trademarkedKeywords.push({ keyword: k, wordmark: m.wordmark, jurisdiction: m.jurisdiction ?? 'US', registration_status: m.registration_status, serial_number: m.serial_number });
    }
    keywords = keywords.filter((kw) => !re.test(kw));
  }
  return {
    image: path.resolve(imagePath),
    engine,
    fields,
    keywords,
    // Tags for other sites are the keywords, best first: each site takes as many as it allows.
    tags: keywords,
    trademarkedKeywords,
    keywordScreen,
    trademark: {
      status: trademarkStatus,
      error: result.trademarkError,
      classes: config.trademarkClasses,
      flaggedTerms: result.trademark?.flaggedTerms ?? [],
      // Marks taken out of the listing, with the term to ban (`iscale ban "<term>"`).
      flaggedMarks: result.trademark?.flaggedMarks ?? [],
      changes: result.trademark?.changes ?? [],
      disclaimer: DISCLAIMER,
    },
    designInfo,
    analysis: {
      visualElements: result.analysis.visualElements,
      detectedText: result.analysis.detectedText,
      mood: result.analysis.mood,
      style: result.analysis.style,
      colors: result.analysis.colors,
    },
  };
}

/** The whole generated listing as it is stored in the design's JSON (`iscale_listings`). */
export function listingRecord(r, { preset } = {}) {
  return {
    generated_at: new Date().toISOString(),
    tool: 'iscale listing generate',
    engine: r.engine,
    ...(preset ? { preset } : {}),
    listing: Object.fromEntries(r.fields.map((f) => [f.id, f.content])),
    fields: r.fields,
    keywords: r.keywords,
    tags: r.tags,
    trademarked_keywords: r.trademarkedKeywords,
    trademark: {
      status: r.trademark.status,
      classes: r.trademark.classes,
      flagged_marks: r.trademark.flaggedMarks,
      changes: r.trademark.changes,
      checked_at: new Date().toISOString(),
      note: r.trademark.disclaimer,
    },
    design_info: { source: r.designInfo.source, ...(r.designInfo.file ? { file: path.basename(r.designInfo.file) } : {}) },
  };
}

/** Save the listing into the design's JSON sidecar. No sidecar: nothing is saved (null). */
export function saveListing(imagePath, r, opts) {
  const target = sidecarWriteTarget(imagePath, r.designInfo.source === 'sidecar' ? r.designInfo.file : null);
  return target ? { file: saveListingToSidecar(target.file, listingRecord(r, opts)) } : null;
}

/** Agent mode: everything a calling AI agent needs to write the listing itself
 *  (on its own subscription), then hand it back to `iscale listing screen`. */
export async function agentTask({ imagePath, settings }) {
  // No shared settings yet: hand the agent the extension's default layout and
  // limits, never an empty field list.
  const core = await loadCore();
  const config = settings?.config ?? core.DEFAULT_LISTING_CONFIG;
  const sidecar = findDesignInfo(imagePath);
  return {
    status: 'awaiting_agent',
    image: path.resolve(imagePath),
    // When the design's sidecar already describes it, the agent need not look at the image.
    ...(sidecar.analysis
      ? { designInfo: { source: 'sidecar', file: sidecar.file, ...sidecar.analysis, rawResponse: undefined }, designNote: 'Use designInfo as the description of the design; the exact text on the design is designInfo.detectedText.' }
      : { designNote: 'Look at the image to see what the design shows and its exact text.' }),
    instructions: config.customInstructions ?? '',
    fields: (config.fields ?? []).map((f) => ({ id: f.id, name: f.name, maxChars: f.maxChars })),
    forbiddenWords: config.forbiddenWords ?? [],
    maxKeywords: core.maxKeywordsOf ? core.maxKeywordsOf(config) : config.maxKeywords,
    trademarkClasses: config.trademarkClasses ?? ['025'],
    next: 'You (the agent running this CLI) write the listing - no ChatGPT/Codex/OpenAI key needed. Write each field within its maxChars, avoid forbiddenWords, save {"fields":[{"name","content"}...],"keywords":[...]} to a file, then run `iscale listing screen <file.json>` (or `iscale check "<each field>" --class <classes>`) and rewrite anything that comes back RISK or UNVERIFIED.',
    disclaimer: DISCLAIMER,
  };
}
