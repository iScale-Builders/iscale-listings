// `iscale check` — screen any text against the user's trademark API with the
// exact policy the extension uses (shared core). Result is risk screening,
// never legal clearance.

import { loadCore } from './core-loader.mjs';

export const DISCLAIMER = 'Trademark results are risk screening, not legal advice or clearance.';

/** Status → process exit code, so agents can branch without parsing text. */
export const EXIT_CODES = { clear: 0, error: 1, risk: 2, unverified: 3 };

/**
 * Screen free text (`text`) and/or individual keywords/tags (`terms`). Terms are
 * screened one-by-one (batched), so two neighbouring tags can never combine into
 * a false phrase match.
 * @param {{ text?: string, terms?: string[], fields?: Array<{id?: string, name?: string, content: string, maxChars?: number}>, classes?: string[], apiBase?: string, allowSingleWord?: boolean }} input
 * @returns {Promise<{ status: 'clear' | 'risk' | 'unverified', reason?: string, incomplete?: boolean, text: string,
 *   classes: string[], jurisdictions: string[], actionable: any[], informational: any[], disclaimer: string }>}
 */
export async function checkText({ text = '', terms = [], fields, classes, apiBase, allowSingleWord = true }) {
  const core = await loadCore();
  if (apiBase) core.setTrademarkApiBase(apiBase);
  const useClasses = classes?.length ? classes : ['025'];
  const base = { text, terms, classes: useClasses, jurisdictions: [...core.TRADEMARK_JURISDICTIONS], disclaimer: DISCLAIMER };
  let actionable = [];
  let informational = [];
  let stale = false;
  try {
    // `fields`: a whole listing, each field screened on its own (as `listing generate`
    // does) so text from two fields can never combine into a false phrase.
    const listingFields = (fields ?? (text.trim() ? [{ id: 'text', name: 'Text', content: text }] : []))
      .filter((f) => String(f?.content ?? '').trim())
      .map((f, i) => ({ fieldId: f.id ?? `field${i + 1}`, fieldName: f.name ?? f.id ?? `Field ${i + 1}`, content: f.content, charCount: f.content.length, maxChars: f.maxChars ?? f.content.length }));
    if (listingFields.length) {
      const listing = { fields: listingFields };
      const result = await core.checkForTrademarks(listing, useClasses);
      actionable = core.getActionableMatches(result.matches, allowSingleWord);
      informational = result.matches.filter((m) => !actionable.includes(m));
      stale = result.data_stale;
    }
    if (terms.length) {
      const screened = await core.screenTermsForTrademarks(terms, useClasses, allowSingleWord);
      const seen = new Set(actionable.map((m) => `${m.jurisdiction ?? 'US'}:${m.serial_number}`));
      for (const [term, m] of screened.flagged) {
        const key = `${m.jurisdiction ?? 'US'}:${m.serial_number}`;
        if (!seen.has(key)) {
          seen.add(key);
          actionable.push({ ...m, term });
        }
      }
      stale ||= screened.stale;
    }
  } catch (e) {
    // A coverage gap or API failure is never "clear" — but a conflict the API
    // DID find in the regions it searched is still a real conflict, so surface it.
    let reason = e instanceof Error ? e.message : String(e);
    // Bad input (unknown class, text too long…) is the caller's mistake, not an
    // unverified result: say what's wrong instead of "UNVERIFIED".
    const invalid = /"code":"(INVALID_[A-Z_]+|UNKNOWN_CLASS|BATCH_TOO_LARGE|CANDIDATE_OVERFLOW)","message":"([^"]+)"/.exec(reason);
    if (invalid) throw new Error(invalid[2]);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|timed? ?out|aborted/i.test(reason)) {
      reason = `Can't reach your trademark API at ${apiBase || 'http://localhost:3000'} — is it running? (\`iscale setup\` shows how; or pass --api URL)`;
    }
    const found = await partialMatches({ text, fields, terms, classes: useClasses, apiBase, allowSingleWord, core });
    return { ...base, status: found.actionable.length ? 'risk' : 'unverified', reason, incomplete: true, ...found };
  }
  if (stale) {
    const reason = 'The trademark data is stale or a region was not searched. Refresh the database, then re-check.';
    return { ...base, status: actionable.length ? 'risk' : 'unverified', reason, incomplete: true, actionable, informational };
  }
  return { ...base, status: actionable.length ? 'risk' : 'clear', actionable, informational };
}

// Matches from whatever regions the API could search, for the degraded path.
async function partialMatches({ text, fields, terms, classes, apiBase, allowSingleWord, core }) {
  const base = (apiBase || process.env.TRADEMARK_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
  const fetchMatches = async (t) => {
    try {
      const resp = await fetch(`${base}/api/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.TRADEMARK_API_KEY ? { 'X-API-Key': process.env.TRADEMARK_API_KEY } : {}) },
        body: JSON.stringify({ text: t, classes, jurisdictions: [...core.TRADEMARK_JURISDICTIONS] }),
        signal: AbortSignal.timeout(20000),
      });
      const data = resp.ok ? await resp.json() : null;
      return Array.isArray(data?.matches) ? data.matches : [];
    } catch {
      return [];
    }
  };
  const all = [];
  const texts = Array.isArray(fields) ? fields.map((f) => String(f?.content ?? '')).filter((t) => t.trim()) : text.trim() ? [text] : [];
  for (const fieldText of texts) all.push(...(await fetchMatches(fieldText)));
  if (terms.length) {
    // Keep only hits that sit inside ONE term, so neighbouring tags can't combine.
    const lowered = terms.map((t) => t.toLowerCase());
    const hits = await fetchMatches(terms.join('\n'));
    all.push(...hits.filter((m) => lowered.some((t) => t.includes(String(m.matched_text).toLowerCase()))));
  }
  const actionable = core.getActionableMatches(all, allowSingleWord);
  return { actionable, informational: all.filter((m) => !actionable.includes(m)) };
}

export function formatCheck(r) {
  const lines = [];
  const icon = { clear: '✓ CLEAR', risk: '⚠ RISK', unverified: '? UNVERIFIED' }[r.status];
  const subject = r.text ? `"${r.text}"` : r.terms?.length ? `${r.terms.length} term(s): ${r.terms.join(', ')}` : '""';
  lines.push(`${icon}  ${subject}  (classes ${r.classes.join(', ')} · ${r.jurisdictions.join(' + ')})`);
  if (r.reason) lines.push(`  ${r.reason}`);
  const groups = new Map();
  for (const m of r.actionable) {
    const key = `${m.wordmark.replace(/\.$/, '').toUpperCase()}|${m.jurisdiction ?? 'US'}|${m.registration_status ?? m.status}`;
    const g = groups.get(key) ?? { m, n: 0 };
    g.n++;
    groups.set(key, g);
  }
  for (const { m, n } of groups.values()) {
    lines.push(`  • ${m.wordmark}  [${m.jurisdiction ?? 'US'} · class ${m.international_class} · ${m.registration_status ?? m.status}]${m.owner ? `  owner: ${m.owner}` : ''}${n > 1 ? `  (${n} records)` : ''}`);
  }
  if (r.informational.length) lines.push(`  (${r.informational.length} informational match(es) not blocking — use --json to see them)`);
  lines.push(`  ${r.disclaimer}`);
  return lines.join('\n');
}
