// Headless listing pipeline orchestration. This is the single source of truth
// for the keyword/listing flow that BOTH the Chrome extension UI and the CLI run
// against — neither surface owns the sequence. It has ZERO React/DOM/chrome
// dependencies (enforced by headless.guard.test.ts); progress is reported through
// an injected `onPhase` callback and Amazon autosuggest through an injected
// fetcher, so each surface supplies its own UI/network adapters.
//
// The order here mirrors the previous extension `runPipeline`/`runAnalyze`
// exactly: analyze → generate candidates → (validate + rank | passthrough) →
// auto-select → generate listing → optional trademark check/rewrite (+ optional
// trademark-final max-fill).

import { hasBannedWord } from '../listing/bannedWords';
import { analyzeImage } from '../analysis/analyzeImage';
import { analyzeAndGenerateCandidates, InvalidCombinedDesignResponse } from '../analysis/analyzeAndGenerateCandidates';
import { generateCandidates } from '../keywords/generateCandidates';
import { validateBatch } from '../validation/validateBatch';
import { rankKeywords } from '../keywords/rankKeywords';
import { generateListing, enforceMaxFillListing, clampToMaxChars } from '../listing/generateListing';
import { trademarkCheckAndRewrite } from '../listing/trademarkCheck';
import type { TrademarkReport } from '../listing/trademarkCheck';
import type {
  AutosuggestFetcher,
  CandidateKeyword,
  GeneratedListing,
  ImageAnalysis,
  ListingConfig,
  ValidatedKeyword,
} from '../types';
import { maxKeywordsOf } from '../types';
import type { AIConfig } from '@/lib/ai-provider';

// ---------------------------------------------------------------------------
// Progress reporting — surface-agnostic. The orchestrator emits semantic phases;
// each caller maps them to its own UI (the extension to loading sublines, the CLI
// to nothing). `validate` carries an optional 0-100 autosuggest progress;
// `trademark` carries the rewrite loop's raw message.
// ---------------------------------------------------------------------------

export type PipelinePhase = 'analyze' | 'generate' | 'validate' | 'rank' | 'listing' | 'trademark';

export interface PipelineProgress {
  /** validate phase: 0-100 autosuggest progress (absent on the initial tick). */
  progress?: number;
  /** trademark phase: the raw status message from the check/rewrite loop. */
  status?: string;
}

export type PipelineReporter = (phase: PipelinePhase, detail?: PipelineProgress) => void;

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface KeywordPipelineInput {
  imageBase64: string;
  /** A design description that is already known (e.g. from the design's JSON
   *  sidecar). When given, the image is not sent to the AI to be described. */
  analysis?: ImageAnalysis;
  aiConfig: AIConfig;
  config: ListingConfig;
  /** Run Amazon autosuggest validation + AI ranking. When false, candidates pass
   *  straight through unvalidated (mirrors the validation toggle being off). */
  validateEnabled: boolean;
}

export interface ListingPipelineInput extends KeywordPipelineInput {
  /** Run the trademark check/rewrite pass after the listing is generated. */
  trademarkEnabled: boolean;
}

export interface PipelineDeps {
  /** Amazon autosuggest fetcher. Required when `validateEnabled` is true. */
  autosuggest: AutosuggestFetcher | null;
  onPhase?: PipelineReporter;
}

export interface KeywordPipelineResult {
  analysis: ImageAnalysis;
  /** Ranked (or passthrough) keywords, BEFORE any auto-selection. */
  ranked: ValidatedKeyword[];
  /** AI ranking was skipped (API error / unparseable) — `ranked` is in raw order. */
  rankingSkipped: boolean;
}

export interface ProduceListingInput {
  aiConfig: AIConfig;
  config: ListingConfig;
  validated: ValidatedKeyword[];
  detectedText?: string[];
  trademarkEnabled: boolean;
}

export interface ProduceListingResult {
  listing: GeneratedListing;
  trademark: TrademarkReport | null;
  trademarkError: string | null;
}

export interface ListingPipelineResult {
  analysis: ImageAnalysis;
  validated: ValidatedKeyword[];
  listing: GeneratedListing;
  trademark: TrademarkReport | null;
  trademarkError: string | null;
  rankingSkipped: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (moved verbatim out of extension/kw-pipeline.ts so both surfaces
// share one implementation)
// ---------------------------------------------------------------------------

/** Auto-select the top `maxKeywords` after ranking, skipping standalone words a
 *  selected longtail phrase already covers. */
export function autoSelectTopN(ranked: ValidatedKeyword[], maxKeywords: number): ValidatedKeyword[] {
  const selectedIndices = new Set<number>();
  const phraseWords = new Set<string>();
  for (let i = 0; i < ranked.length && selectedIndices.size < maxKeywords; i++) {
    const kwd = ranked[i];
    if (kwd.isPhrase) {
      selectedIndices.add(i);
      kwd.word
        .toLowerCase()
        .split(/\s+/)
        .forEach((w) => phraseWords.add(w));
    } else if (!phraseWords.has(kwd.word.toLowerCase())) {
      selectedIndices.add(i);
    }
  }
  return ranked.map((kwd, index) => ({ ...kwd, selected: selectedIndices.has(index) }));
}

/** Build unvalidated keywords straight from candidates (validation toggle off). */
export function passthroughValidated(candidates: CandidateKeyword[]): ValidatedKeyword[] {
  return candidates.map((c) => ({
    id: c.id,
    word: c.word,
    source: c.source,
    isPhrase: c.isPhrase,
    subWords: c.isPhrase ? c.word.split(' ').filter(Boolean) : [],
    validations: [],
    certified: false,
    bestPosition: null,
    bestVariant: null,
    selected: false,
  }));
}

/** Overlay a fieldId->content record (e.g. a trademark rewrite's finalListing)
 *  onto a listing, recomputing charCount. */
export function listingWithFinalContent(
  listing: GeneratedListing,
  finalListing: Record<string, string>
): GeneratedListing {
  return {
    ...listing,
    fields: listing.fields.map((field) => {
      // Clamp to the field limit so an overlaid rewrite can't ship over maxChars.
      // Idempotent — content that already fits passes through unchanged.
      const content = clampToMaxChars(finalListing[field.fieldId] ?? field.content, field.maxChars);
      return { ...field, content, charCount: content.length };
    }),
  };
}

/** When Max Fill is on, top the trademark-clean final listing up toward each
 *  field's char limit using the still-usable (non-blocked, selected) keywords.
 *  Mutates `trademark.finalListing` in place, matching the prior extension
 *  behaviour. */
function applyTrademarkFinalMaxFill(
  listing: GeneratedListing,
  trademark: TrademarkReport,
  validated: ValidatedKeyword[],
  config: ListingConfig
): void {
  const blockedTerms = trademark.flaggedTerms;
  const blocked = new Set(blockedTerms.map((term) => term.toLowerCase()));
  const usableKeywords = validated
    .filter((keyword) => keyword.selected)
    .filter((keyword) => !blocked.has(keyword.word.toLowerCase()));
  const filled = enforceMaxFillListing(
    listingWithFinalContent(listing, trademark.finalListing),
    config,
    usableKeywords,
    blockedTerms
  );
  trademark.finalListing = Object.fromEntries(filled.fields.map((field) => [field.fieldId, field.content]));
}

export interface AppendKeywordsInput {
  listing: GeneratedListing;
  trademark: TrademarkReport | null;
  /** All validated keywords; the function selects the picked, non-blocked ones. */
  keywords: ValidatedKeyword[];
  config: ListingConfig;
}

export interface AppendKeywordsResult {
  /** Updated listing — use when there is no trademark report. */
  listing: GeneratedListing;
  /** Updated fieldId->content map — use when a trademark report is present
   *  (its `finalListing` is what the UI renders), else null. */
  finalListing: Record<string, string> | null;
}

/** Incremental "add keywords" pass: top the current listing up with the selected,
 *  non-trademark-blocked keywords without an AI rewrite. Pure — the caller decides
 *  whether to commit the result to the listing or to `trademark.finalListing`.
 *  Extracted verbatim from the extension's `appendSelectedKeywordsToListing` so the
 *  fast regenerate path is core-backed like the rest of the pipeline. */
export function appendKeywordsToListing(input: AppendKeywordsInput): AppendKeywordsResult {
  const { listing, trademark, keywords, config } = input;
  const blockedTerms = trademark?.flaggedTerms ?? [];
  const blocked = new Set(blockedTerms.map((term) => term.toLowerCase()));
  const selectedKeywords = keywords
    .filter((keyword) => keyword.selected)
    .filter((keyword) => !blocked.has(keyword.word.toLowerCase()));
  const base = trademark ? listingWithFinalContent(listing, trademark.finalListing) : listing;
  const filled = enforceMaxFillListing(base, config, selectedKeywords, blockedTerms);
  if (trademark) {
    return {
      listing,
      finalListing: Object.fromEntries(filled.fields.map((field) => [field.fieldId, field.content])),
    };
  }
  return { listing: filled, finalListing: null };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** Analyze → generate candidates → (validate + rank | passthrough). The shared
 *  prefix used by both the full auto pipeline and the manual analyze flow. */
export async function generateKeywords(
  input: KeywordPipelineInput,
  deps: PipelineDeps
): Promise<KeywordPipelineResult> {
  const { imageBase64, config, validateEnabled } = input;
  const aiConfig = input.aiConfig.provider === 'codex' ? { ...input.aiConfig, localReasoningEffort: input.aiConfig.localReasoningEffort ?? 'low' as const } : input.aiConfig;
  const apiKey = aiConfig.apiKey;
  const { autosuggest, onPhase } = deps;

  onPhase?.('analyze', input.analysis ? undefined : { status: 'Reading your design and finding keywords…' });
  let analysis: ImageAnalysis;
  let generated: CandidateKeyword[];
  if (input.analysis) {
    // A trusted design sidecar/manual analysis needs no new vision request.
    analysis = input.analysis;
    onPhase?.('generate');
    generated = await generateCandidates({ apiKey, analysis, aiConfig, forbiddenWords: config.forbiddenWords });
  } else {
    try {
      ({ analysis, candidates: generated } = await analyzeAndGenerateCandidates({ imageBase64, aiConfig, forbiddenWords: config.forbiddenWords }));
      onPhase?.('generate', { status: 'Keyword ideas ready' });
    } catch (error) {
      // Transport errors still fail loudly. Only invalid returned JSON warrants
      // the explicitly bounded original two-call fallback.
      if (!(error instanceof InvalidCombinedDesignResponse)) throw error;
      onPhase?.('analyze', { status: 'Trying design analysis again…' });
      const normalBudget = input.aiConfig;
      analysis = await analyzeImage({ apiKey, imageBase64, aiConfig: normalBudget });
      onPhase?.('generate');
      generated = await generateCandidates({ apiKey, analysis, aiConfig: normalBudget, forbiddenWords: config.forbiddenWords });
    }
  }
  // The AI is asked to avoid banned words; drop any it suggests anyway so a
  // banned word can never become a keyword (pill / tag / max-fill filler).
  const candidates = generated.filter((c) => !hasBannedWord(c.word, config.forbiddenWords));

  let ranked: ValidatedKeyword[];
  let rankingSkipped = false;
  if (validateEnabled) {
    if (!autosuggest) {
      throw new Error('runListingPipeline: validateEnabled requires an autosuggest fetcher');
    }
    onPhase?.('validate');
    const validated = await validateBatch(candidates, autosuggest, config.productVariants, {
      concurrency: 8,
      onProgress: (p) => onPhase?.('validate', { progress: Math.round(p) }),
    });
    onPhase?.('rank');
    ranked = await rankKeywords({
      apiKey,
      analysis,
      validatedKeywords: validated,
      aiConfig,
      onRankingSkipped: () => {
        rankingSkipped = true;
      },
    });
  } else {
    ranked = passthroughValidated(candidates);
  }

  return { analysis, ranked, rankingSkipped };
}

/** Generate the listing from a chosen keyword selection, then the optional
 *  trademark check/rewrite (+ optional trademark-final max-fill). Shared by the
 *  full auto pipeline and the extension's incremental regenerate path. */
export async function produceListing(
  input: ProduceListingInput,
  deps: { onPhase?: PipelineReporter } = {}
): Promise<ProduceListingResult> {
  const { config, validated, detectedText, trademarkEnabled } = input;
  const aiConfig = input.aiConfig.provider === 'codex' ? { ...input.aiConfig, localReasoningEffort: input.aiConfig.localReasoningEffort ?? 'medium' as const } : input.aiConfig;
  const apiKey = aiConfig.apiKey;
  const { onPhase } = deps;

  onPhase?.('listing');
  const listing = await generateListing({
    apiKey,
    validatedKeywords: validated,
    config,
    detectedText,
    aiConfig,
    ...(aiConfig.provider === 'codex' ? { qualityReasoningEffort: input.aiConfig.localReasoningEffort ?? 'medium' as const } : {}),
  });

  let trademark: TrademarkReport | null = null;
  let trademarkError: string | null = null;
  if (trademarkEnabled) {
    try {
      trademark = await trademarkCheckAndRewrite(listing, validated, config, aiConfig, (msg) =>
        onPhase?.('trademark', { status: msg })
      );
      if (config.maxFill && trademark) {
        applyTrademarkFinalMaxFill(listing, trademark, validated, config);
      }
    } catch (e) {
      trademarkError = e instanceof Error ? e.message : String(e);
    }
  }

  return { listing, trademark, trademarkError };
}

/** The full auto pipeline: keywords → auto-select top N → listing → trademark.
 *  This is the entrypoint the CLI `iscale.listing.generate` and the extension's
 *  Auto run both call. */
export async function runListingPipeline(
  input: ListingPipelineInput,
  deps: PipelineDeps
): Promise<ListingPipelineResult> {
  const { aiConfig, config, trademarkEnabled } = input;

  const { analysis, ranked, rankingSkipped } = await generateKeywords(input, deps);
  const validated = autoSelectTopN(ranked, maxKeywordsOf(config));

  const { listing, trademark, trademarkError } = await produceListing(
    { aiConfig, config, validated, detectedText: analysis.detectedText, trademarkEnabled },
    { onPhase: deps.onPhase }
  );

  return { analysis, validated, listing, trademark, trademarkError, rankingSkipped };
}
