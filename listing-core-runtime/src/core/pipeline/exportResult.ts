// Shared `iscale.export.results` shaper. Both surfaces export through this one
// function so the CLI's machine-readable output and the extension's "Export JSON"
// affordance are guaranteed identical. Headless — no DOM, no chrome, no network.
//
// It folds any trademark rewrite into the per-field content (so an export always
// carries the trademark-clean text the seller would actually publish) and derives
// a short list of human review actions from the trademark/validation state.

import type { GeneratedListing, ImageAnalysis, ValidatedKeyword } from '../types';
import type { TrademarkChange, TrademarkReport } from '../listing/trademarkCheck';

export interface ExportInput {
  analysis: ImageAnalysis | null;
  keywords: ValidatedKeyword[];
  listing: GeneratedListing | null;
  trademark: TrademarkReport | null;
  trademarkError?: string | null;
  appVersion?: string;
  /** ISO-8601 timestamp. Injected so the result is deterministic/testable. */
  createdAt?: string;
}

export interface ExportField {
  fieldId: string;
  fieldName: string;
  content: string;
  charCount: number;
  maxChars: number;
  keywordsUsed: string[];
}

export interface ExportKeyword {
  word: string;
  source: string;
  certified: boolean;
  selected: boolean;
  unverified: boolean;
}

export interface ExportResult {
  listing: { fields: ExportField[] } | null;
  keywords: ExportKeyword[];
  trademark: {
    clean: boolean;
    stale: boolean;
    flaggedTerms: string[];
    changes: TrademarkChange[];
  } | null;
  trademark_error: string | null;
  review_actions: string[];
  app_version: string | null;
  created_at: string | null;
}

/** Trademark-clean content for a field: the rewrite's final text if present, else
 *  the generated content. Mirrors the extension's `fieldContent`. */
function finalContent(fieldId: string, fallback: string, trademark: TrademarkReport | null): string {
  return trademark?.finalListing?.[fieldId] ?? fallback;
}

/** Whole-word presence of a keyword in the (possibly trademark-rewritten) final
 *  content — so exported `keywordsUsed` reflects what's actually in the published
 *  copy, not the pre-rewrite generation metadata. */
function wordPresentInContent(content: string, word: string): boolean {
  const w = word.toLowerCase().trim();
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(content.toLowerCase());
}

function deriveReviewActions(input: ExportInput): string[] {
  const { keywords, trademark, trademarkError } = input;
  const actions: string[] = [];
  if (trademarkError) {
    actions.push(`Trademark check failed (${trademarkError}); re-run before relying on clearance.`);
  }
  if (trademark?.stale) {
    actions.push('Trademark data was stale; this listing is NOT definitively cleared — re-check before publishing.');
  }
  if (trademark && !trademark.clean && !trademark.stale && trademark.flaggedTerms.length) {
    actions.push(`Listing still flags after rewrite: ${trademark.flaggedTerms.join(', ')}. Review before listing.`);
  }
  const unverified = keywords.filter((k) => !k.certified && k.unverified === true).length;
  if (unverified) {
    actions.push(`${unverified} keyword${unverified === 1 ? '' : 's'} could not be verified on Amazon; treat as unchecked, not rejected.`);
  }
  return actions;
}

export function buildExportResult(input: ExportInput): ExportResult {
  const { listing, keywords, trademark, trademarkError, appVersion, createdAt } = input;

  const exportListing: ExportResult['listing'] = listing
    ? {
        fields: listing.fields.map((f) => {
          const content = finalContent(f.fieldId, f.content, trademark);
          return {
            fieldId: f.fieldId,
            fieldName: f.fieldName,
            content,
            charCount: content.length,
            maxChars: f.maxChars,
            // Recompute against the FINAL content: a trademark rewrite may have
            // removed a flagged keyword (or max-fill added words), so the
            // generation-time `f.keywordsUsed` can be stale.
            keywordsUsed: keywords.filter((k) => wordPresentInContent(content, k.word)).map((k) => k.word),
          };
        }),
      }
    : null;

  return {
    listing: exportListing,
    keywords: keywords.map((k) => ({
      word: k.word,
      source: k.source,
      certified: k.certified,
      selected: k.selected,
      unverified: k.unverified === true,
    })),
    trademark: trademark
      ? {
          clean: trademark.clean,
          stale: trademark.stale,
          flaggedTerms: trademark.flaggedTerms,
          changes: trademark.changes,
        }
      : null,
    trademark_error: trademarkError ?? null,
    review_actions: deriveReviewActions(input),
    app_version: appVersion ?? null,
    created_at: createdAt ?? null,
  };
}
