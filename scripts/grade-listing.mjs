#!/usr/bin/env node
// Grade a generated listing against measurable listing rules, so "did the AI follow
// the prompt?" is answered by numbers, not by eye.
//
//   iscale listing generate design.png --json > listing.json
//   node scripts/grade-listing.mjs listing.json [--json]
//
// Checks: each field's length vs its limit (Title/Brand >= 90%, other fields >= 85%),
// words the Brand shares with the Title, words used more than twice across the other
// fields, how many offered keywords made it into the copy, and what the trademark
// check removed (it can shorten fields after they are written).
import fs from 'node:fs';

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'by', 'at', 'is', 'it', 'its', 'your', 'my', 'our', 'this', 'that', 'as', 'from', 'who', 'all']);
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => !STOP.has(w));
const role = (f) => {
  const k = `${f.id ?? ''} ${f.name ?? ''}`.toLowerCase();
  return k.includes('title') ? 'title' : k.includes('brand') ? 'brand' : 'body';
};

export function gradeListing(doc) {
  const fields = Array.isArray(doc?.fields) ? doc.fields : [];
  const checks = [];
  for (const f of fields) {
    const len = String(f.content ?? '').length;
    const target = Math.floor(f.maxChars * (role(f) === 'body' ? 0.85 : 0.9));
    checks.push({ check: `${f.name} length`, pass: len >= target && len <= f.maxChars, detail: `${len}/${f.maxChars} (target ${target}-${f.maxChars})` });
  }
  const title = fields.find((f) => role(f) === 'title');
  const brand = fields.find((f) => role(f) === 'brand');
  if (title && brand) {
    const t = new Set(words(title.content));
    const shared = [...new Set(words(brand.content))].filter((w) => t.has(w));
    checks.push({ check: 'Brand uses different words than Title', pass: shared.length <= 1, detail: shared.length ? `shared: ${shared.join(', ')}` : 'none shared' });
  }
  for (const f of [title, brand].filter(Boolean)) {
    const w = words(f.content);
    const dup = [...new Set(w)].filter((x) => w.filter((y) => y === x).length > 1);
    checks.push({ check: `${f.name} has no repeated words`, pass: dup.length === 0, detail: dup.length ? `repeated: ${dup.join(', ')} (ok only inside different longtail keywords)` : 'none' });
  }
  const counts = new Map();
  for (const f of fields.filter((x) => role(x) === 'body')) for (const w of words(f.content)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const over = [...counts].filter(([, n]) => n > 2);
  checks.push({ check: 'Other fields do not overuse words', pass: over.length === 0, detail: over.length ? over.map(([w, n]) => `${w} x${n}`).join(', ') : 'none used more than twice' });
  const kws = Array.isArray(doc?.keywords) ? doc.keywords : [];
  const body = fields.map((f) => String(f.content ?? '').toLowerCase()).join(' \n ');
  const used = kws.filter((k) => body.includes(String(k).toLowerCase()));
  const removed = (doc?.trademark?.changes ?? []).map((c) => c.original ?? c.from ?? c.term).filter(Boolean);
  return {
    score: `${checks.filter((c) => c.pass).length}/${checks.length}`,
    checks,
    keywordsUsed: `${used.length} of ${kws.length} offered`,
    trademark: doc?.trademark?.status ?? 'unknown',
    removedByTrademarkCheck: removed,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/grade-listing.mjs')) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/grade-listing.mjs <listing.json> [--json]');
    process.exit(1);
  }
  const g = gradeListing(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  if (process.argv.includes('--json')) console.log(JSON.stringify(g, null, 2));
  else {
    console.log(`Score ${g.score} | keywords used ${g.keywordsUsed} | trademark ${g.trademark}`);
    for (const c of g.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}: ${c.detail}`);
    if (g.removedByTrademarkCheck.length) console.log(`Removed by the trademark check: ${g.removedByTrademarkCheck.join(', ')}`);
  }
  process.exitCode = g.checks.every((c) => c.pass) ? 0 : 2;
}
